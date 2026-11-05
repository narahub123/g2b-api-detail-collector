import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DetailQueue } from "./detail-queue";
import { createQueuedCollection, produceQueuedCollection, queuedCheckpoint } from "./queued-collection";
import { consumeDetails } from "./detail-worker";
import { G2bMaintenanceError } from "./maintenance";
import { consumeCollectionQueue } from "./collection-queue-worker";
import { RELATED_NOTICE_MAX_LIMIT } from "@/lib/g2b/constants";

/** 실제 API 응답 형식을 유지하면서 검사 대상 공고를 반환합니다. */
const api = (numbers: string[]) => async () => Response.json({ response: { body: {
  totalCount: numbers.length, numOfRows: 100, pageNo: 1,
  items: numbers.map(bidNtceNo => ({ bidNtceNo, bidNtceOrd: "000" })),
} } });

describe.skipIf(process.env.LIVE_DB_TEST !== "1" || !process.env.DATABASE_URL)("날짜·자동 수집 큐 통합", { timeout: 60_000 }, () => {
  const schema = `queued_collection_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10_000 });
  const queue = new DetailQueue(pool, schema, { collectionMode: true, legacyCollectionLock: true });
  const start = "2026-11-01T00:00:00.000Z", end = "2026-11-01T01:00:00.000Z";
  const a = "R26BK10000001", b = "R26BK10000002", c = "R26BK10000003";
  const oldKey = process.env.G2B_SERVICE_KEY;
  beforeAll(async () => {
    process.env.G2B_SERVICE_KEY = "test-key";
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const file of ["db/schema.sql", "db/migrations/0014-detail-queue.sql", "db/migrations/0015-detail-refresh-jobs.sql", "db/migrations/0016-queued-collection.sql"]) {
      const ddl = (await readFile(file, "utf8")).replaceAll("public.", `${schema}.`);
      await pool.query(ddl);
      await pool.query(ddl);
    }
  }, 60_000);
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${schema}.detail_collection_jobs,${schema}.detail_collection_requests,${schema}.detail_collection_runs,
      ${schema}.detail_collection_targets,${schema}.detail_collection_checkpoints,${schema}.collection_notice_attempts,${schema}.notices CASCADE`);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL`);
    await pool.query(`INSERT INTO ${schema}.detail_collection_producer_lease(id) VALUES(1) ON CONFLICT DO NOTHING`);
    await pool.query(`UPDATE ${schema}.detail_collection_producer_lease SET owner_token=NULL,job_id=NULL,expires_at=NULL`);
    await pool.query(`INSERT INTO ${schema}.collection_lock(id) VALUES(1) ON CONFLICT DO NOTHING`);
    await pool.query(`UPDATE ${schema}.collection_lock SET job_id=NULL,token=NULL,expires_at=NULL`);
  }, 60_000);
  afterAll(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await pool.end(); if (oldKey === undefined) delete process.env.G2B_SERVICE_KEY; else process.env.G2B_SERVICE_KEY = oldKey; }
  }, 60_000);

  it("API 접수가 끝나면 상세 대기 중에도 체크포인트를 전진시키고 다음 구간부터 조회합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    await produceQueuedCollection(queue, job.id, { fetcher: api([a, b]) });
    const waiting = await queue.getRefreshJob(job.id);
    expect(waiting).toMatchObject({ mode: "incremental", status: "queued", apiStatus: "completed", detailQueued: 2 });
    expect(waiting?.apiCompletedAt).toBeDefined();
    expect(await queuedCheckpoint(queue)).toBe(end);
    const next = await createQueuedCollection(queue, { mode: "incremental", start, end: "2026-11-01T02:00:00.000Z" });
    await produceQueuedCollection(queue, next.id, { fetcher: api([]) });
    expect((await queue.getRefreshJob(next.id))?.windowStart).toBe(end);
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_runs`)).rowCount).toBe(2);
  });

  it("API 중간 실패는 이미 접수한 상세를 보존하고 체크포인트를 전진시키지 않습니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    await produceQueuedCollection(queue, job.id, { fetcher: async () => Response.json({ response: { body: {
      totalCount: 2, numOfRows: 100, pageNo: 1, items: [{ bidNtceNo: a, bidNtceOrd: "000" }],
    } } }) });
    expect(await queuedCheckpoint(queue)).toBeNull();
    expect((await queue.getRefreshJob(job.id))?.apiStatus).toBe("failed");
    expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.detail_collection_runs`)).rows[0].n).toBeLessThanOrEqual(1);
  });

  it("자동 소비 중 들어온 직접 요청을 다음 공고부터 우선 처리합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    await produceQueuedCollection(queue, job.id, { fetcher: api([a, b]) });
    await queue.saveApi(`${c}--000`, { bidNtceNo: c, bidNtceOrd: "000" });
    const seen: string[] = [];
    await consumeDetails(queue, { scrape: async url => {
      const number = new URL(url).searchParams.get("bidPbancNo")!;
      seen.push(number);
      if (number === a) await queue.submitRefresh([`${c}--000`]);
      return { detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [] };
    } });
    expect(seen).toEqual([a, c, b]);
  });

  it("자동 실패는 보완으로 내려가 총 세 번에서 중지하고 직접 재수집은 계속 접수합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    await produceQueuedCollection(queue, job.id, { fetcher: api([a]) });
    let count = 0;
    const scrape = async () => { count++; throw Error("상세 실패"); };
    for (let i = 0; i < 4; i++) {
      await pool.query(`UPDATE ${schema}.detail_collection_runs SET next_attempt_at=NULL WHERE status='queued'`);
      await consumeDetails(queue, { scrape });
    }
    expect(count).toBe(3);
    expect((await queue.getRefreshJob(job.id))?.detailFailed).toBe(1);
    expect((await pool.query(`SELECT attempts FROM ${schema}.collection_notice_attempts WHERE key=$1`, [`${a}--000`])).rows[0].attempts).toBe(3);
    const manual = await queue.submitRefresh([`${a}--000`]);
    await consumeDetails(queue, { scrape: async url => ({ detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [] }) });
    expect((await queue.getRefreshJob(manual.id))?.detailSucceeded).toBe(1);
  });

  it("관련 공고의 순환·중복을 막고 관계와 모든 후속 요청을 함께 저장합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "collection", start, end, range: { start: "2026-11-01T09:00", end: "2026-11-01T10:00" } });
    await produceQueuedCollection(queue, job.id, { fetcher: api([a]) });
    const seen: string[] = [];
    await consumeDetails(queue, { fetcher: api([b]), scrape: async url => {
      const number = new URL(url).searchParams.get("bidPbancNo")!;
      seen.push(number);
      return { detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: number === a ? [`${b}--000`, `${b}--000`] : [`${a}--000`] };
    } });
    expect(seen).toEqual([a, b]);
    expect((await queue.getRefreshJob(job.id))?.detailSucceeded).toBe(2);
    expect((await pool.query(`SELECT * FROM ${schema}.notice_relations`)).rowCount).toBe(2);
  });

  it("API 점검과 상세 점검은 체크포인트와 시도 횟수를 구분합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    await produceQueuedCollection(queue, job.id, { fetcher: async () => { throw new G2bMaintenanceError("api"); } });
    expect(await queuedCheckpoint(queue)).toBeNull();
    await pool.query(`UPDATE ${schema}.detail_collection_jobs SET next_api_attempt_at=NULL`);
    await produceQueuedCollection(queue, job.id, { fetcher: api([a]) });
    await consumeDetails(queue, { scrape: async () => { throw new G2bMaintenanceError("detail"); } });
    expect(await queuedCheckpoint(queue)).toBe(end);
    expect((await pool.query(`SELECT * FROM ${schema}.collection_notice_attempts`)).rowCount).toBe(0);
  });

  it("API 생산자가 다음 페이지를 기다리는 중에도 상세와 직접 요청을 처리합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    await queue.saveApi(`${c}--000`, { bidNtceNo: c, bidNtceOrd: "000" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    await consumeCollectionQueue(queue, {
      fetcher: async input => {
        const pageNo = Number(new URL(String(input)).searchParams.get("pageNo"));
        if (pageNo === 2) await gate;
        return Response.json({ response: { body: { totalCount: 2, numOfRows: 1, pageNo,
          items: [{ bidNtceNo: pageNo === 1 ? a : b, bidNtceOrd: "000" }] } } });
      },
      scrape: async url => {
        const number = new URL(url).searchParams.get("bidPbancNo")!;
        seen.push(number);
        if (number === a) {
          expect((await queue.getRefreshJob(job.id))?.apiStatus).toBe("running");
          await queue.submitRefresh([`${c}--000`]);
          release();
        }
        return { detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [] };
      },
    });
    expect(seen).toEqual([a, c, b]);
    expect((await queue.getRefreshJob(job.id))?.status).toBe("completed");
  });

  it("후속 접수 오류는 상세·관계·시도 기록을 함께 롤백합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    await produceQueuedCollection(queue, job.id, { fetcher: api([a]) });
    await pool.query(`CREATE FUNCTION ${schema}.reject_followup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '후속 접수 실패'; END $$`);
    await pool.query(`CREATE TRIGGER reject_followup BEFORE INSERT ON ${schema}.detail_collection_requests FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_followup()`);
    try {
      await expect(consumeDetails(queue, { scrape: async url => ({ detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [`${b}--000`] }) }))
        .rejects.toThrow("후속 접수 실패");
      expect((await pool.query(`SELECT detail FROM ${schema}.notices WHERE key=$1`, [`${a}--000`])).rows[0].detail).toBeNull();
      expect((await pool.query(`SELECT * FROM ${schema}.notice_relations`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT * FROM ${schema}.collection_notice_attempts`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_runs`)).rowCount).toBe(1);
      expect(await queuedCheckpoint(queue)).toBe(end);
    } finally { await pool.query(`DROP TRIGGER reject_followup ON ${schema}.detail_collection_requests`); }
  });

  it("API 원본 갱신과 접수 중 오류가 나면 해당 공고 전체를 롤백합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    await pool.query(`CREATE FUNCTION ${schema}.reject_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF EXISTS(SELECT 1 FROM ${schema}.detail_collection_runs WHERE id=NEW.run_id AND notice_key='${b}--000') THEN
      RAISE EXCEPTION '둘째 공고 접수 실패'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_second BEFORE INSERT ON ${schema}.detail_collection_requests FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_second()`);
    try {
      await produceQueuedCollection(queue, job.id, { fetcher: api([a, b]) });
      expect((await queue.getRefreshJob(job.id))?.apiStatus).toBe("failed");
      expect((await pool.query(`SELECT * FROM ${schema}.notices WHERE key=$1`, [`${b}--000`])).rowCount).toBe(0);
      expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_runs`)).rowCount).toBe(1);
      expect(await queuedCheckpoint(queue)).toBeNull();
    } finally { await pool.query(`DROP TRIGGER reject_second ON ${schema}.detail_collection_requests`); }
  });

  it("API 임대를 잃은 생산자는 접수·체크포인트·새 소유권을 덮어쓰지 못합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    const next = randomUUID();
    await expect(produceQueuedCollection(queue, job.id, { fetcher: async () => {
      await pool.query(`UPDATE ${schema}.detail_collection_producer_lease SET owner_token=$1,expires_at=now()+interval '2 minutes' WHERE id=1`, [next]);
      return api([a])();
    } })).rejects.toThrow("소유권");
    expect((await pool.query(`SELECT * FROM ${schema}.notices`)).rowCount).toBe(0);
    expect(await queuedCheckpoint(queue)).toBeNull();
    expect((await pool.query(`SELECT owner_token FROM ${schema}.detail_collection_producer_lease`)).rows[0].owner_token).toBe(next);
  });

  it("API 중단을 재개해도 접수는 중복되지 않고 완료 뒤에만 체크포인트를 갱신합니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    const abort = new AbortController();
    await produceQueuedCollection(queue, job.id, { fetcher: api([a, b]), signal: abort.signal, onEnqueue: () => abort.abort() });
    expect(await queuedCheckpoint(queue)).toBeNull();
    expect((await queue.getRefreshJob(job.id))?.apiStatus).toBe("queued");
    await produceQueuedCollection(queue, job.id, { fetcher: api([a, b]) });
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_runs`)).rowCount).toBe(2);
    expect(await queuedCheckpoint(queue)).toBe(end);
  });

  it("관련 공고는 작업당 200건으로 제한하고 보류 이유를 남깁니다", async () => {
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end });
    await produceQueuedCollection(queue, job.id, { fetcher: api([a]) });
    const abort = new AbortController();
    const children = Array.from({ length: 201 }, (_value, i) => `R26BK${String(20000000 + i)}--000`);
    await consumeDetails(queue, { signal: abort.signal, scrape: async url => {
      abort.abort();
      return { detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: children };
    } });
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_targets WHERE is_related`)).rowCount).toBe(RELATED_NOTICE_MAX_LIMIT);
    expect((await pool.query(`SELECT * FROM ${schema}.detail_collection_runs`)).rowCount).toBe(201);
    expect((await queue.getRefreshJob(job.id))?.errors.join(" ")).toContain("한도(200건)");
  });

  it("활성화별 체크포인트와 최대 네 시간 구간을 분리합니다", async () => {
    const first = await createQueuedCollection(queue, { mode: "incremental", start, end: "2026-11-01T06:00:00.000Z", activationId: "A" });
    await produceQueuedCollection(queue, first.id, { fetcher: api([]) });
    expect(await queuedCheckpoint(queue, "A")).toBe("2026-11-01T04:00:00.000Z");
    expect((await queue.getRefreshJob(first.id))?.continuation).toBe(true);
    const second = await createQueuedCollection(queue, { mode: "incremental", start, end, activationId: "B" });
    await produceQueuedCollection(queue, second.id, { fetcher: api([]) });
    expect((await queue.getRefreshJob(second.id))?.windowStart).toBe(start);
    expect(await queuedCheckpoint(queue, "B")).toBe(end);
  });

  it("기존 완료 이력의 체크포인트도 새 큐의 조회 시작점으로 보존합니다", async () => {
    await pool.query(`INSERT INTO ${schema}.collection_jobs(id,state,status,started_at)
      VALUES($1,$2::jsonb,'completed',now())`, [randomUUID(), JSON.stringify({ mode: "incremental", windowEnd: end, activationId: "legacy" })]);
    const job = await createQueuedCollection(queue, { mode: "incremental", start, end: "2026-11-01T02:00:00.000Z", activationId: "legacy" });
    await produceQueuedCollection(queue, job.id, { fetcher: api([]) });
    expect((await queue.getRefreshJob(job.id))?.windowStart).toBe(end);
    expect(await queuedCheckpoint(queue, "legacy")).toBe("2026-11-01T02:00:00.000Z");
  });
});
