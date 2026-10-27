import pg from "pg";
import { noticeKeyFromParts } from "./identity";
import { normalizeNotice } from "./normalize";
import type { StoredNotice } from "./notices";
import type { IndependentDetail, StructuredNoticeDetail } from "./structured-data";
import type { ModalCapture } from "./detail-page";
import type { NoticeFilters } from "./notice-filters";

type Category = "order-plan" | "pre-specification" | "other" | "opening";
type Queryable = Pick<pg.PoolClient, "query">;
type StoredRow = { key: string; api: StoredNotice["api"]; detail: StoredNotice["detail"];
  detail_error: string | null };
type ReferenceRow = { detail_key: string; category: Category; triggers: ModalCapture["trigger"][] };

const runtime = globalThis as typeof globalThis & { __g2bPgPool?: pg.Pool };

/** 풀러 세션의 search_path와 무관하게 지정한 스키마의 테이블을 가리킵니다. */
function table(name: "notices" | "independent_details" | "notice_independent_refs" | "notice_relations"): string {
  const schema = process.env.G2B_DB_SCHEMA || "public";
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("잘못된 DB 스키마 이름입니다.");
  return `${schema}.${name}`;
}

/** 서버에서 공유할 PostgreSQL 연결 풀을 반환합니다. */
export function getPool(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 환경변수를 설정하세요.");
  return runtime.__g2bPgPool ||= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
}

/** 나라장터 현지 시각 문자열을 시간대 변환 없이 DB 시각으로 바꿉니다. */
function localTimestamp(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/[-/: T]/g, "");
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?$/.exec(compact);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

/** 정규화된 공고에서 SQL 분석용 요약 값을 만듭니다. */
export function noticeSummary(key: string, record: Pick<StoredNotice, "api" | "detail">) {
  const [number, order] = key.split("--");
  if (noticeKeyFromParts(number, order) !== key) throw new Error(`잘못된 공고 키: ${key}`);
  const normalized = normalizeNotice(record.api, record.detail, { number, order });
  if (normalized.key !== key) throw new Error(`공고 원본과 저장 키가 일치하지 않습니다: ${key}`);
  return { number, order, title: normalized.title.value,
    demandAgency: normalized.demandAgency.value, noticeAgency: normalized.noticeAgency.value,
    postedAt: localTimestamp(normalized.postedAt.value), deadlineAt: localTimestamp(normalized.deadline.value),
    amount: normalized.amount.value?.replaceAll(",", "").replace(/\s*원$/, "") || null,
    region: normalized.region.value, description: normalized.description.value,
    servicePeriod: normalized.servicePeriod.value, qualifications: normalized.qualifications.value };
}

/** 공고의 본문과 분석 컬럼을 같은 문장으로 갱신합니다. */
async function upsertNotice(db: Queryable, key: string, record: StoredNotice): Promise<void> {
  const summary = noticeSummary(key, record);
  await db.query(`INSERT INTO ${table("notices")}
    (key, notice_number, notice_order, api, detail, detail_error, title, demand_agency, notice_agency, posted_at, deadline_at,
     amount, region, description, service_period, qualifications)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10::timestamp,$11::timestamp,$12::numeric,$13,$14,$15,$16)
    ON CONFLICT (key) DO UPDATE SET api=EXCLUDED.api, detail=EXCLUDED.detail,
      detail_error=EXCLUDED.detail_error, title=EXCLUDED.title,
      demand_agency=EXCLUDED.demand_agency, notice_agency=EXCLUDED.notice_agency,
      posted_at=EXCLUDED.posted_at, deadline_at=EXCLUDED.deadline_at, amount=EXCLUDED.amount,
      region=EXCLUDED.region, description=EXCLUDED.description,
      service_period=EXCLUDED.service_period, qualifications=EXCLUDED.qualifications, updated_at=now()`,
    [key, summary.number, summary.order, record.api ? JSON.stringify(record.api) : null,
      record.detail ? JSON.stringify(record.detail) : null, record.detailError || null,
      summary.title, summary.demandAgency, summary.noticeAgency, summary.postedAt, summary.deadlineAt, summary.amount,
      summary.region, summary.description, summary.servicePeriod, summary.qualifications]);
}

/** 트랜잭션 안에서 여러 저장 단계를 원자적으로 처리합니다. */
async function transaction<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { db.release(); }
}

/** 공고와 새 독립 상세 및 참조를 원자적으로 저장합니다. */
export async function saveStoredNotice(key: string, record: StoredNotice,
  structured?: StructuredNoticeDetail): Promise<void> {
  await transaction(async (db) => {
    await upsertNotice(db, key, record);
    if (!structured) return;
    const groups: [Category, IndependentDetail[]][] = [
      ["order-plan", structured.orderPlans], ["pre-specification", structured.preSpecifications],
      ["other", structured.otherDetails], ["opening", structured.openingDetails]
    ];
    // 상세와 참조를 함께 교체해야 재수집 중 실패가 기존 연결을 훼손하지 않습니다.
    await db.query(`DELETE FROM ${table("notice_independent_refs")} WHERE notice_key=$1`, [key]);
    for (const [category, details] of groups) {
      for (const [position, detail] of details.entries()) {
        const match = category === "other" ? /^(R\d{2}BK\d{8})-(\d{3})$/.exec(detail.number) : null;
        const existingNotice = match ? await db.query(`SELECT detail FROM ${table("notices")} WHERE key=$1`, [`${match[1]}--${match[2]}`]) : null;
        if (!existingNotice?.rows[0]?.detail) {
          // 현재 형식의 최초 저장값은 유지하고, 재수집한 이전 형식만 새 자료로 교체합니다.
          await db.query(`INSERT INTO ${table("independent_details")}(detail_key,category,payload) VALUES($1,$2,$3::jsonb)
            ON CONFLICT(detail_key) DO UPDATE SET payload=EXCLUDED.payload
            WHERE (independent_details.payload->>'schemaVersion') IS DISTINCT FROM '5'`,
            [detail.number, category, JSON.stringify(detail)]);
        }
        const triggers = structured.independentTriggers.filter((item) => item.number === detail.number).map((item) => item.trigger);
        await db.query(`INSERT INTO ${table("notice_independent_refs")}(notice_key,detail_key,category,position,triggers)
          VALUES($1,$2,$3,$4,$5::jsonb)`, [key, detail.number, category, position, JSON.stringify(triggers)]);
      }
    }
  });
}

/** 공고 관계를 양쪽 방향으로 한 번에 저장합니다. */
export async function saveNoticeRelation(source: string, related: string): Promise<void> {
  if (source === related) return;
  await transaction(async (db) => {
    for (const key of [source, related]) {
      const [number, order] = key.split("--");
      if (noticeKeyFromParts(number, order) !== key) throw new Error(`잘못된 공고 키: ${key}`);
      await db.query(`INSERT INTO ${table("notices")}(key,notice_number,notice_order) VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`, [key, number, order]);
    }
    await db.query(`INSERT INTO ${table("notice_relations")}(source_key,related_key) VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING`,
      [source, related]);
  });
}

/** DB에서 공고 원본과 직접 관계·독립 상세 참조를 읽습니다. */
export async function getStoredNotice(key: string): Promise<StoredNotice | null> {
  const result = await getPool().query<StoredRow>(`SELECT key,api,detail,detail_error FROM ${table("notices")} WHERE key=$1`, [key]);
  const row = result.rows[0];
  if (!row) return null;
  const [relations, refs] = await Promise.all([
    getPool().query<{ related_key: string }>(`SELECT related_key FROM ${table("notice_relations")} WHERE source_key=$1 ORDER BY related_key`, [key]),
    getPool().query<ReferenceRow>(`SELECT detail_key,category,triggers FROM ${table("notice_independent_refs")} WHERE notice_key=$1 ORDER BY category,position`, [key])
  ]);
  return { key, api: row.api, detail: row.detail, detailError: row.detail_error,
    relatedNoticeKeys: relations.rows.map((item) => item.related_key),
    orderPlanNumbers: refs.rows.filter((item) => item.category === "order-plan").map((item) => item.detail_key),
    preSpecificationNumbers: refs.rows.filter((item) => item.category === "pre-specification").map((item) => item.detail_key),
    otherDetailNumbers: refs.rows.filter((item) => item.category === "other").map((item) => item.detail_key),
    openingDetailKeys: refs.rows.filter((item) => item.category === "opening").map((item) => item.detail_key),
    independentTriggers: refs.rows.flatMap((item) => item.triggers.map((trigger) => ({ number: item.detail_key, trigger }))) };
}

/** 건수와 목록 조회에 공통으로 적용할 검색·필터 SQL을 구성합니다. */
function noticeWhere(filters: NoticeFilters): { where: string; values: string[] } {
  const clauses: string[] = [];
  const values: string[] = [];
  const add = (sql: (index: number) => string, value: string | undefined) => {
    if (value === undefined) return;
    values.push(value);
    clauses.push(sql(values.length));
  };

  // 검색 컬럼은 허용된 두 컬럼 중에서만 선택하고 값은 매개변수로 전달합니다.
  if (filters.query) {
    const column = filters.searchField === "notice_number" ? "notice_number" : "title";
    add((index) => `strpos(lower(${column}), lower($${index})) > 0`, filters.query);
  }
  add((index) => `posted_at >= $${index}::date`, filters.postedFrom);
  add((index) => `posted_at < ($${index}::date + interval '1 day')`, filters.postedTo);
  add((index) => `deadline_at >= $${index}::date`, filters.deadlineFrom);
  add((index) => `deadline_at < ($${index}::date + interval '1 day')`, filters.deadlineTo);
  add((index) => `amount >= $${index}::numeric`, filters.minAmount);
  add((index) => `amount <= $${index}::numeric`, filters.maxAmount);
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}

/** 검색·필터 조건에 맞는 전체 공고 수를 DB에서 조회합니다. */
export async function countStoredNotices(filters: NoticeFilters = {}): Promise<number> {
  const { where, values } = noticeWhere(filters);
  const result = await getPool().query<{ total: string }>(`SELECT COUNT(*) AS total FROM ${table("notices")}${where}`, values);
  return Number(result.rows[0]?.total || 0);
}

/** 지정한 조건을 DB에서 적용하고 목록에 표시할 공고 키를 게시일 역순으로 반환합니다. */
export async function listStoredNoticeKeys(filters: NoticeFilters = {}, pagination?: { limit: number; offset: number }): Promise<string[]> {
  const { where, values } = noticeWhere(filters);
  const pageClause = pagination ? ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}` : "";
  const params: (string | number)[] = pagination ? [...values, pagination.limit, pagination.offset] : values;
  const result = await getPool().query<{ key: string }>(`SELECT key FROM ${table("notices")}${where} ORDER BY posted_at DESC NULLS LAST, key${pageClause}`, params);
  return result.rows.map((row) => row.key);
}

/** 번호별 독립 상세를 반환합니다. */
export async function getStoredIndependentDetail(number: string): Promise<IndependentDetail | null> {
  const result = await getPool().query<{ payload: IndependentDetail }>(`SELECT payload FROM ${table("independent_details")} WHERE detail_key=$1`, [number]);
  return result.rows[0]?.payload || null;
}
