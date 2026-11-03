import { randomUUID } from "node:crypto";
import type pg from "pg";
import { serializeError } from "../error-diagnostics";
import { redactDiagnostic } from "./collection-diagnostics";
import { noticeKeyFromParts } from "./identity";
import type { StoredNotice } from "./notices";
import { saveNoticeApiInTransaction, saveNoticeRelationInTransaction, saveStoredNoticeInTransaction } from "./postgres-store";
import type { StructuredNoticeDetail } from "./structured-data";
import type { ApiNotice } from "./types";

export type DetailRequest = {
  key: string;
  jobId: string;
  source: "manual" | "automatic";
  purpose: "initial" | "reextract";
};
export type DetailRun = {
  id: string;
  notice_key: string;
  source: DetailRequest["source"];
  purpose: DetailRequest["purpose"];
  status: "queued" | "processing" | "succeeded" | "failed";
  owner_token: string | null;
};
type Finish = { status: "succeeded"; detail: NonNullable<StoredNotice["detail"]>;
  structured?: StructuredNoticeDetail; relatedKeys?: string[]; followups?: DetailRequest[] }
  | { status: "failed"; error: string; diagnostic?: unknown };

/** 공고 키 오류가 DB 잠금을 잡기 전에 드러나도록 검증합니다. */
function parts(key: string) {
  const [number, order, extra] = key.split("--");
  if (extra !== undefined || noticeKeyFromParts(number, order) !== key) throw new Error("잘못된 공고 키입니다.");
  return { number, order };
}

/** 요청 접수와 공고 실행을 분리하고 짧은 저장 트랜잭션에서만 임대 행을 잠급니다. */
export class DetailQueue {
  /** 연결 풀과 검사된 스키마를 사용하며 기존 수집 경로는 변경하지 않습니다. */
  constructor(readonly pool: pg.Pool, readonly schema = process.env.G2B_DB_SCHEMA || "public") {
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("잘못된 DB 스키마 이름입니다.");
  }

  /** 동일 연결에서 작업을 확정하거나 롤백하고 연결을 반환합니다. */
  async transaction<T>(work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query("SET LOCAL statement_timeout='15s'");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { db.release(); }
  }

  /** 모든 큐 쓰기의 잠금 순서를 소비기 임대부터 시작하도록 직렬화합니다. */
  private async lockLease(db: pg.PoolClient) {
    const row = await db.query(`SELECT * FROM ${this.schema}.detail_collection_worker_lease WHERE id=1 FOR UPDATE`);
    if (!row.rowCount) throw new Error("상세 큐 스키마가 준비되지 않았습니다.");
  }

  /** 임대 행 잠금을 유지한 연결에서 토큰과 현재 유효기간을 검사합니다. */
  private async owned(db: pg.PoolClient, token: string) {
    const row = await db.query(`SELECT 1 FROM ${this.schema}.detail_collection_worker_lease
      WHERE id=1 AND owner_token=$1 AND expires_at>clock_timestamp()`, [token]);
    if (!row.rowCount) throw new Error("상세 소비기 임대 소유권을 잃었습니다.");
  }

  /** 공고 자리표시자를 확보하며 기존 API와 상세는 수정하지 않습니다. */
  private async ensureNotice(db: pg.PoolClient, key: string) {
    const { number, order } = parts(key);
    await db.query(`INSERT INTO ${this.schema}.notices(key,notice_number,notice_order)
      VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`, [key, number, order]);
  }

  /** 다른 소비기의 유효한 임대를 빼앗지 않고 단일 실행권을 얻습니다. */
  async acquire(token: string): Promise<boolean> {
    const row = await this.pool.query(`UPDATE ${this.schema}.detail_collection_worker_lease
      SET owner_token=$1,expires_at=clock_timestamp()+interval '120 seconds'
      WHERE id=1 AND (owner_token IS NULL OR expires_at<=clock_timestamp()) RETURNING id`, [token]);
    return !!row.rowCount;
  }

  /** 만료된 소비기가 새 소유권을 갱신할 수 없도록 제한합니다. */
  async renew(token: string): Promise<boolean> {
    const row = await this.pool.query(`UPDATE ${this.schema}.detail_collection_worker_lease
      SET expires_at=clock_timestamp()+interval '120 seconds'
      WHERE id=1 AND owner_token=$1 AND expires_at>clock_timestamp() RETURNING id`, [token]);
    return !!row.rowCount;
  }

  /** 자신의 소비기 임대만 반환하며 새 소유자의 임대는 보존합니다. */
  async release(token: string): Promise<void> {
    await this.pool.query(`UPDATE ${this.schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL
      WHERE id=1 AND owner_token=$1`, [token]);
  }

  /** 이미 시작한 트랜잭션에 요청을 연결하여 API 저장과 접수를 함께 확정합니다.
   * @remarks 다른 행을 쓰기 전에 호출해야 임대→실행→공고의 잠금 순서를 유지합니다.
   */
  async enqueueInTransaction(db: pg.PoolClient, request: DetailRequest): Promise<DetailRun> {
    parts(request.key);
    await this.lockLease(db);
    const active = (await db.query<DetailRun>(`SELECT * FROM ${this.schema}.detail_collection_runs
      WHERE notice_key=$1 AND status IN ('queued','processing') FOR UPDATE`, [request.key])).rows[0];
    let run = active;
    // API 재발견이 실패 복구 대기를 최초 수집으로 되돌리지 않도록 기존 목적은 유지합니다.
    if (active?.status === "queued" && request.source === "manual") {
      // 새 직접 요청은 자동 재시도의 지연 시각도 해제하여 다음 선점부터 처리합니다.
      run = (await db.query<DetailRun>(`UPDATE ${this.schema}.detail_collection_runs SET source='manual',next_attempt_at=NULL
        WHERE id=$1 RETURNING *`, [active.id])).rows[0];
    }
    if (!run) {
      await this.ensureNotice(db, request.key);
      run = (await db.query<DetailRun>(`INSERT INTO ${this.schema}.detail_collection_runs
        (id,notice_key,source,purpose) VALUES($1,$2,$3,$4) RETURNING *`,
      [randomUUID(), request.key, request.source, request.purpose])).rows[0];
    }
    await db.query(`INSERT INTO ${this.schema}.detail_collection_requests(job_id,run_id)
      VALUES($1,$2) ON CONFLICT DO NOTHING`, [request.jobId, run.id]);
    return run;
  }

  /** 같은 공고의 활성 실행을 공유하고 대기 중인 자동 요청을 직접 요청으로 승격합니다. */
  async enqueue(request: DetailRequest): Promise<DetailRun> {
    return this.transaction(db => this.enqueueInTransaction(db, request));
  }

  /** 준비된 요청 중 직접·자동 최초·자동 보완 순서로 공고 하나를 선점합니다. */
  async claim(token: string): Promise<DetailRun | null> {
    return this.transaction(async db => {
      await this.lockLease(db);
      await this.owned(db, token);
      // 공고마다 다시 선택하므로 새 직접 요청이 기존 자동 대기보다 먼저 실행됩니다.
      const run = (await db.query<DetailRun>(`SELECT * FROM ${this.schema}.detail_collection_runs
        WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp())
        ORDER BY CASE WHEN source='manual' THEN 0 WHEN purpose='initial' THEN 1 ELSE 2 END,requested_at,id
        LIMIT 1 FOR UPDATE`)).rows[0];
      if (!run) return null;
      await db.query(`SELECT key FROM ${this.schema}.notices WHERE key=$1 FOR UPDATE`, [run.notice_key]);
      const claimed = (await db.query<DetailRun>(`UPDATE ${this.schema}.detail_collection_runs
        SET status='processing',owner_token=$2,started_at=clock_timestamp(),next_attempt_at=NULL
        WHERE id=$1 RETURNING *`, [run.id, token])).rows[0];
      await this.owned(db, token);
      return claimed;
    });
  }

  /** 모든 상세 쓰기를 같은 연결의 임대→실행→공고 잠금 아래 수행합니다.
   * @param work 외부 통신 없이 전달된 연결만 사용하는 짧은 DB 작업
   * @throws 소비기 임대 또는 공고 실행의 소유권을 잃으면 전체 저장을 롤백합니다.
   */
  async withRun<T>(token: string, id: string,
    work: (db: pg.PoolClient, run: DetailRun, current: StoredNotice) => Promise<T>): Promise<T> {
    return this.transaction(async db => {
      await this.lockLease(db);
      await this.owned(db, token);
      const run = (await db.query<DetailRun>(`SELECT * FROM ${this.schema}.detail_collection_runs WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!run || run.status !== "processing" || run.owner_token !== token) throw new Error("공고 실행 소유권을 잃었습니다.");
      const row = (await db.query(`SELECT api,detail,detail_error,detail_diagnostic FROM ${this.schema}.notices
        WHERE key=$1 FOR UPDATE`, [run.notice_key])).rows[0];
      if (!row) throw new Error("상세 수집 공고가 없습니다.");
      const result = await work(db, run, { api: row.api, detail: row.detail,
        detailError: row.detail_error, detailDiagnostic: row.detail_diagnostic });
      // 긴 DB 저장 중 임대가 만료되어도 결과를 확정하지 않습니다.
      await this.owned(db, token);
      return result;
    });
  }

  /** 관측 중간 상태에도 공고 실행 소유권을 적용합니다. */
  async progress(token: string, id: string, progress: Record<string, unknown>): Promise<void> {
    await this.withRun(token, id, async db => {
      await db.query(`UPDATE ${this.schema}.detail_collection_runs SET progress=$2::jsonb WHERE id=$1`,
        [id, JSON.stringify(progress)]);
    });
  }

  /** 중간 오류를 최신 원본과 병합하여 성공 상세를 보존합니다. */
  async saveError(token: string, id: string, error: string, diagnostic?: unknown): Promise<void> {
    await this.withRun(token, id, async (db, run, current) => {
      await saveStoredNoticeInTransaction(db, run.notice_key, { ...current,
        detailError: redactDiagnostic(error), detailDiagnostic: diagnostic ? serializeError(diagnostic) : null }, undefined, this.schema);
    });
  }

  /** 중간 관계 저장도 소유권을 검사하고 같은 트랜잭션에서 반영합니다. */
  async saveRelations(token: string, id: string, keys: string[]): Promise<void> {
    await this.withRun(token, id, async (db, run) => {
      for (const key of [...new Set(keys)].sort()) await saveNoticeRelationInTransaction(db, run.notice_key, key, this.schema);
    });
  }

  /** API 생산자가 현재 상세·오류를 보존하면서 API 원본과 요약만 갱신합니다. */
  async saveApiInTransaction(db: pg.PoolClient, key: string, api: ApiNotice): Promise<void> {
    parts(key);
    await saveNoticeApiInTransaction(db, key, api, this.schema);
  }

  /** 단독 API 갱신을 짧은 트랜잭션으로 확정합니다. */
  async saveApi(key: string, api: ApiNotice): Promise<void> {
    await this.transaction(db => this.saveApiInTransaction(db, key, api));
  }

  /** 상세·참조·관계·후속 요청과 실행 종료를 함께 저장합니다. */
  async finish(token: string, id: string, result: Finish): Promise<void> {
    await this.withRun(token, id, async (db, run, current) => {
      if (result.status === "succeeded") {
        await saveStoredNoticeInTransaction(db, run.notice_key,
          { ...current, detail: result.detail, detailError: null, detailDiagnostic: null }, result.structured, this.schema);
        for (const key of [...new Set(result.relatedKeys ?? [])].sort())
          await saveNoticeRelationInTransaction(db, run.notice_key, key, this.schema);
        for (const request of result.followups ?? []) await this.enqueueInTransaction(db, request);
      } else {
        await saveStoredNoticeInTransaction(db, run.notice_key, { ...current,
          detailError: redactDiagnostic(result.error), detailDiagnostic: result.diagnostic ? serializeError(result.diagnostic) : null }, undefined, this.schema);
      }
      await db.query(`UPDATE ${this.schema}.detail_collection_runs SET status=$2,owner_token=NULL,
        finished_at=clock_timestamp(),error=$3,diagnostic=$4::jsonb WHERE id=$1`, [id, result.status,
        result.status === "failed" ? redactDiagnostic(result.error) : null,
        result.status === "failed" && result.diagnostic ? JSON.stringify(serializeError(result.diagnostic)) : null]);
    });
  }

  /** 새 소비기가 이전 실행의 미완료 공고를 실패 횟수 증가 없이 대기로 돌립니다. */
  async recover(token: string): Promise<number> {
    return this.transaction(async db => {
      await this.lockLease(db);
      await this.owned(db, token);
      const rows = await db.query(`UPDATE ${this.schema}.detail_collection_runs
        SET status='queued',owner_token=NULL,started_at=NULL,progress='{}'::jsonb
        WHERE status='processing' AND owner_token<>$1`, [token]);
      await this.owned(db, token);
      return rows.rowCount ?? 0;
    });
  }
}
