import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DetailQueue } from "./detail-queue";
import { structureNoticeDetail } from "./structured-data";

const enabled = process.env.LIVE_DB_TEST === "1" && !!process.env.DATABASE_URL;

describe.skipIf(!enabled)("상세 큐 저장 경계", { timeout: 60_000 }, () => {
  const schema = `detail_queue_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
  const queue = new DetailQueue(pool, schema);
  const key = "R26BK10000001--000";
  let token: string;
  let created = false;

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    created = true;
    await pool.query((await readFile("db/schema.sql", "utf8")).replaceAll("public.", `${schema}.`));
    const ddl = (await readFile("db/migrations/0014-detail-queue.sql", "utf8")).replaceAll("public.", `${schema}.`);
    await pool.query(ddl);
    await pool.query(ddl);
  }, 60_000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${schema}.detail_collection_requests, ${schema}.detail_collection_runs,
      ${schema}.notice_relations, ${schema}.notice_independent_refs, ${schema}.independent_details, ${schema}.notices CASCADE`);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL`);
    token = randomUUID();
    expect(await queue.acquire(token)).toBe(true);
  }, 60_000);
  afterAll(async () => {
    try { if (created) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await pool.end(); }
  }, 60_000);

  it("직접 요청을 자동 최초·보완보다 먼저 선택하고 미래 재시도는 제외합니다", async () => {
    const repair = await queue.enqueue({ key, source: "automatic", purpose: "reextract", jobId: randomUUID() });
    const initial = await queue.enqueue({ key: "R26BK10000002--000", source: "automatic", purpose: "initial", jobId: randomUUID() });
    const manual = await queue.enqueue({ key: "R26BK10000003--000", source: "manual", purpose: "reextract", jobId: randomUUID() });
    expect((await queue.claim(token))?.id).toBe(manual.id);
    await queue.finish(token, manual.id, { status: "failed", error: "종료" });
    expect((await queue.claim(token))?.id).toBe(initial.id);
    await queue.finish(token, initial.id, { status: "failed", error: "종료" });
    await pool.query(`UPDATE ${schema}.detail_collection_runs SET next_attempt_at=now()+interval '1 hour' WHERE id=$1`, [repair.id]);
    expect(await queue.claim(token)).toBeNull();
  });

  it("동시 접수를 하나로 합치고 직접 요청으로 승격하며 모든 작업 연결을 보존합니다", async () => {
    const jobs = [randomUUID(), randomUUID()];
    const [a, b] = await Promise.all(jobs.map((jobId, i) => queue.enqueue({ key, jobId,
      source: i ? "manual" : "automatic", purpose: "initial" })));
    expect(a.id).toBe(b.id);
    const claimed = await queue.claim(token);
    expect(claimed?.source).toBe("manual");
    const c = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "reextract" });
    expect(c.id).toBe(a.id);
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_requests`)).rowCount).toBe(3);
    await queue.finish(token, a.id, { status: "failed", error: "종료" });
    expect((await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "reextract" })).id).not.toBe(a.id);
  });

  it("API 재발견은 보완 대기를 최초 수집으로 승격하지 않고 직접 요청만 최우선으로 올립니다", async () => {
    const retry = await queue.enqueue({ key, jobId: randomUUID(), source: "automatic", purpose: "reextract" });
    const rediscovered = await queue.enqueue({ key, jobId: randomUUID(), source: "automatic", purpose: "initial" });
    expect(rediscovered.id).toBe(retry.id);
    expect(rediscovered.purpose).toBe("reextract");
    const first = await queue.enqueue({ key: "R26BK10000002--000", jobId: randomUUID(), source: "automatic", purpose: "initial" });
    expect((await queue.claim(token))?.id).toBe(first.id);
    await queue.finish(token, first.id, { status: "failed", error: "종료" });
    await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    const next = await queue.claim(token);
    expect(next?.id).toBe(retry.id);
    expect(next?.source).toBe("manual");
    expect(next?.purpose).toBe("reextract");
  });

  it("소비기 경쟁·갱신·해제는 현재 토큰만 허용합니다", async () => {
    const other = randomUUID();
    expect(await queue.acquire(other)).toBe(false);
    expect(await queue.renew(other)).toBe(false);
    await queue.release(other);
    expect(await queue.renew(token)).toBe(true);
    await queue.release(token);
    expect(await queue.renew(token)).toBe(false);
    expect(await queue.acquire(other)).toBe(true);
  });

  it("직접 요청은 자동 보완의 미래 재시도 시각을 해제합니다", async () => {
    const retry = await queue.enqueue({ key, jobId: randomUUID(), source: "automatic", purpose: "reextract" });
    await pool.query(`UPDATE ${schema}.detail_collection_runs SET next_attempt_at=now()+interval '1 hour' WHERE id=$1`, [retry.id]);
    await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "reextract" });
    expect((await queue.claim(token))?.id).toBe(retry.id);
  });

  it("만료된 소비기는 진행·오류·관계·최종 저장을 할 수 없습니다", async () => {
    const run = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    await queue.claim(token);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET expires_at=now()-interval '1 second'`);
    await expect(queue.progress(token, run.id, { stage: "saving" })).rejects.toThrow("소유권");
    await expect(queue.saveError(token, run.id, "오래된 오류")).rejects.toThrow("소유권");
    await expect(queue.saveRelations(token, run.id, ["R26BK10000002--000"])).rejects.toThrow("소유권");
    await expect(queue.finish(token, run.id, { status: "succeeded", detail: {
      sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] } })).rejects.toThrow("소유권");
    expect((await pool.query(`SELECT detail_error,detail FROM ${schema}.notices WHERE key=$1`, [key])).rows[0])
      .toEqual({ detail_error: null, detail: null });
    expect((await pool.query(`SELECT * FROM ${schema}.notice_relations`)).rowCount).toBe(0);
  });

  it("API 저장과 상세 저장을 분리해 최신 API와 성공 상세를 보존합니다", async () => {
    const run = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    await queue.claim(token);
    await queue.saveApi(key, { bidNtceNo: "R26BK10000001", bidNtceOrd: "000", bidNtceNm: "최신 API" });
    const detail = { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] };
    await queue.finish(token, run.id, { status: "succeeded", detail });
    await queue.saveApi(key, { bidNtceNo: "R26BK10000001", bidNtceOrd: "000", bidNtceNm: "갱신 API" });
    const row = (await pool.query(`SELECT api,detail FROM ${schema}.notices WHERE key=$1`, [key])).rows[0];
    expect(row.api.bidNtceNm).toBe("갱신 API");
    expect(row.detail).toEqual(detail);
  });

  it("API 생산자는 상세와 오류 컬럼을 갱신하지 않습니다", async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION ${schema}.reject_detail_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'API 저장이 상세 컬럼을 수정했습니다'; END $$`);
    await pool.query(`CREATE TRIGGER reject_detail_update BEFORE UPDATE OF detail,detail_error,detail_diagnostic
      ON ${schema}.notices FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_detail_update()`);
    try {
      await queue.saveApi(key, { bidNtceNo: "R26BK10000001", bidNtceOrd: "000", bidNtceNm: "API 전용 저장" });
      expect((await pool.query(`SELECT api FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].api.bidNtceNm)
        .toBe("API 전용 저장");
    } finally { await pool.query(`DROP TRIGGER reject_detail_update ON ${schema}.notices`); }
  });

  it("완료된 실행은 유효한 소비기 토큰으로도 중간 저장을 할 수 없습니다", async () => {
    const run = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    await queue.claim(token);
    await queue.finish(token, run.id, { status: "failed", error: "최종 오류" });
    await expect(queue.saveError(token, run.id, "잘못된 덮어쓰기")).rejects.toThrow("소유권");
    expect((await pool.query(`SELECT detail_error FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].detail_error).toBe("최종 오류");
  });

  it("유효한 소유자의 중간 진행·관계를 저장하고 잘못된 관계는 전부 롤백합니다", async () => {
    const run = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    await queue.claim(token);
    await queue.progress(token, run.id, { stage: "opening" });
    expect((await pool.query(`SELECT progress FROM ${schema}.detail_collection_runs WHERE id=$1`, [run.id])).rows[0].progress)
      .toEqual({ stage: "opening" });
    await expect(queue.saveRelations(token, run.id, ["R26BK10000002--000", "잘못된 키"])).rejects.toThrow();
    expect((await pool.query(`SELECT * FROM ${schema}.notice_relations`)).rowCount).toBe(0);
    await queue.saveRelations(token, run.id, ["R26BK10000002--000"]);
    expect((await pool.query(`SELECT * FROM ${schema}.notice_relations`)).rowCount).toBe(2);
  });

  it("후속 요청 저장 실패는 상세·관계·실행 완료를 함께 롤백합니다", async () => {
    const run = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    await queue.claim(token);
    const structured = structureNoticeDetail(key, { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] });
    structured.openingDetails.push({ schemaVersion: 5, number: `opening--${key}--001`, title: "개찰",
      capturedAt: new Date().toISOString(), sourceNoticeKey: key, sections: [] });
    await expect(queue.finish(token, run.id, { status: "succeeded", detail: structured.detail, structured,
      relatedKeys: ["R26BK10000002--000"], followups: [{ key: "R26BK10000002--000",
        source: "automatic", purpose: "initial", jobId: "invalid-uuid" }] })).rejects.toThrow();
    expect((await pool.query(`SELECT detail FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].detail).toBeNull();
    expect((await pool.query(`SELECT * FROM ${schema}.notice_relations`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT * FROM ${schema}.independent_details`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT * FROM ${schema}.notice_independent_refs`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT status FROM ${schema}.detail_collection_runs WHERE id=$1`, [run.id])).rows[0].status).toBe("processing");
  });

  it("API와 요청을 같은 연결에서 확정하고 실패하면 자리표시자까지 롤백합니다", async () => {
    const request = { key, jobId: randomUUID(), source: "automatic" as const, purpose: "initial" as const };
    await expect(queue.transaction(async db => {
      await queue.enqueueInTransaction(db, request);
      await queue.saveApiInTransaction(db, key, { bidNtceNo: "다른 공고", bidNtceOrd: "000" });
    })).rejects.toThrow("일치하지 않습니다");
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_runs`)).rowCount).toBe(0);
    expect((await pool.query(`SELECT * FROM ${schema}.notices`)).rowCount).toBe(0);
    await queue.transaction(async db => {
      await queue.enqueueInTransaction(db, request);
      await queue.saveApiInTransaction(db, key, { bidNtceNo: "R26BK10000001", bidNtceOrd: "000" });
    });
    expect((await pool.query(`SELECT api FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].api.bidNtceNo).toBe("R26BK10000001");
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_requests`)).rowCount).toBe(1);
  });

  it("저장 도중 임대가 만료되면 이미 쓴 중간 변경도 롤백합니다", async () => {
    const run = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    await queue.claim(token);
    await expect(queue.withRun(token, run.id, async db => {
      await db.query(`UPDATE ${schema}.notices SET detail_error='확정되면 안 되는 오류' WHERE key=$1`, [key]);
      // 실제 시간 경과와 같은 만료 상태를 만들어 커밋 직전 검사까지 검증합니다.
      await db.query(`UPDATE ${schema}.detail_collection_worker_lease SET expires_at=clock_timestamp()`);
    })).rejects.toThrow("소유권");
    expect((await pool.query(`SELECT detail_error FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].detail_error).toBeNull();
  });

  it("성공 상세·참조·관계·후속 요청을 함께 확정하고 이후 실패에도 성공 상세를 보존합니다", async () => {
    const run = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    await queue.claim(token);
    const structured = structureNoticeDetail(key, { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [] });
    structured.openingDetails.push({ schemaVersion: 5, number: `opening--${key}--001`, title: "개찰",
      capturedAt: new Date().toISOString(), sourceNoticeKey: key, sections: [] });
    const related = "R26BK10000002--000";
    await queue.finish(token, run.id, { status: "succeeded", detail: structured.detail, structured, relatedKeys: [related],
      followups: [{ key: related, jobId: randomUUID(), source: "automatic", purpose: "initial" }] });
    expect((await pool.query(`SELECT * FROM ${schema}.notice_independent_refs`)).rowCount).toBe(1);
    expect((await pool.query(`SELECT * FROM ${schema}.notice_relations`)).rowCount).toBe(2);
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_requests`)).rowCount).toBe(2);
    const again = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "reextract" });
    expect((await queue.claim(token))?.id).toBe(again.id);
    await queue.saveError(token, again.id, "중간 오류");
    await queue.finish(token, again.id, { status: "failed", error: "실패" });
    expect((await pool.query(`SELECT detail FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].detail).toEqual(structured.detail);
    expect((await pool.query(`SELECT * FROM ${schema}.notice_independent_refs`)).rowCount).toBe(1);
  });

  it("소유권 검사 중 임대 교체는 저장 트랜잭션 종료까지 대기합니다", async () => {
    const run = await queue.enqueue({ key, jobId: randomUUID(), source: "manual", purpose: "initial" });
    await queue.claim(token);
    const other = await pool.connect();
    try {
      await queue.withRun(token, run.id, async () => {
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout='100ms'");
        await expect(other.query(`UPDATE ${schema}.detail_collection_worker_lease SET owner_token=$1`, [randomUUID()])).rejects.toThrow();
        await other.query("ROLLBACK");
      });
    } finally { other.release(); }
  });

  it("새 소유자는 중단 실행을 복구하고 이전 토큰의 쓰기를 거절합니다", async () => {
    const run = await queue.enqueue({ key, jobId: randomUUID(), source: "automatic", purpose: "initial" });
    await queue.claim(token);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET expires_at=now()-interval '1 second'`);
    const next = randomUUID();
    expect(await queue.acquire(next)).toBe(true);
    expect(await queue.recover(next)).toBe(1);
    expect((await queue.claim(next))?.id).toBe(run.id);
    await expect(queue.saveError(token, run.id, "이전 실행")).rejects.toThrow("소유권");
    await queue.saveError(next, run.id, "새 실행");
    expect((await pool.query(`SELECT detail_error FROM ${schema}.notices WHERE key=$1`, [key])).rows[0].detail_error).toBe("새 실행");
  });
});
