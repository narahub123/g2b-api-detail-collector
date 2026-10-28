import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { expect, it } from "vitest";
import { startCollection, startRefresh, getCollectionJob } from "./collection-job";
import { getNoticeRecord, listNotices } from "./notices";

const runtime = globalThis as typeof globalThis & { __g2bPgPool?: pg.Pool };

it.skipIf(!process.env.LIVE_DB_TEST || !process.env.DATABASE_URL)(
  "renames existing text identifiers without changing their values", async () => {
    const schema = `g2b_test_${randomUUID().replaceAll("-", "")}`;
    const directUrl = new URL(process.env.DATABASE_URL!);
    directUrl.hostname = directUrl.hostname.replace("-pooler.", ".");
    const client = new pg.Client({ connectionString: directUrl.toString() });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`CREATE TABLE ${schema}.notices (
        key text PRIMARY KEY, number text NOT NULL, notice_order text NOT NULL, UNIQUE(number, notice_order))`);
      await client.query(`CREATE TABLE ${schema}.independent_details (number text PRIMARY KEY)`);
      await client.query(`CREATE TABLE ${schema}.notice_independent_refs (notice_key text, number text)`);
      await client.query(`CREATE INDEX notice_independent_refs_number_idx ON ${schema}.notice_independent_refs(number)`);
      await client.query(`INSERT INTO ${schema}.notices(key,number,notice_order) VALUES('R26BK1--000','R26BK1','000')`);
      await client.query(`INSERT INTO ${schema}.independent_details(number) VALUES('R26DD12345678')`);
      await client.query(`INSERT INTO ${schema}.notice_independent_refs(notice_key,number) VALUES('R26BK1--000','R26DD12345678')`);
      const migration = (await readFile(join(process.cwd(), "db", "migrations", "0002-rename-text-identifiers.sql"), "utf8"))
        .replaceAll("public.", `${schema}.`).replaceAll("table_schema = 'public'", `table_schema = '${schema}'`);
      await client.query(migration);
      await client.query(migration);
      const notice = await client.query(`SELECT notice_number FROM ${schema}.notices WHERE key='R26BK1--000'`);
      const detail = await client.query(`SELECT detail_key FROM ${schema}.independent_details`);
      const reference = await client.query(`SELECT detail_key FROM ${schema}.notice_independent_refs`);
      expect(notice.rows[0].notice_number).toBe("R26BK1");
      expect(detail.rows[0].detail_key).toBe("R26DD12345678");
      expect(reference.rows[0].detail_key).toBe("R26DD12345678");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  }, 30_000);

/** 완료된 파일 작업 상태를 제한된 시간 동안 기다립니다. */
async function finished(id: string, dir: string) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const job = await getCollectionJob(id, dir);
    if (job?.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("수집 작업 시간 초과");
}

it.skipIf(!process.env.LIVE_DB_TEST || !process.env.DATABASE_URL)(
  "stores collection, relations, independent details and refresh in an isolated PostgreSQL schema", async () => {
    const schema = `g2b_test_${randomUUID().replaceAll("-", "")}`;
    const directUrl = new URL(process.env.DATABASE_URL!);
    directUrl.hostname = directUrl.hostname.replace("-pooler.", ".");
    const admin = new pg.Client({ connectionString: directUrl.toString() });
    const dir = await mkdtemp(join(tmpdir(), "g2b-postgres-flow-"));
    const originalKey = process.env.G2B_SERVICE_KEY;
    const originalSchema = process.env.G2B_DB_SCHEMA;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const ddl = await readFile(join(process.cwd(), "db", "schema.sql"), "utf8");
      await admin.query(ddl.replaceAll("public.", `${schema}.`));
      process.env.G2B_DB_SCHEMA = schema;
      runtime.__g2bPgPool = new pg.Pool({ connectionString: directUrl.toString(), max: 2 });
      process.env.G2B_SERVICE_KEY = "test-key";
      const fetcher = async () => new Response(JSON.stringify({ response: { header: { resultCode: "00" },
        body: { totalCount: 1, items: [{ bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "연구 용역",
          bidNtceDt: "202610250930", presmptPrce: "1,200" }] } } }));
      const scrape = async (url: string) => ({ detail: {
        sourceUrl: url, sections: [{ title: "공고일반", fields: [{ label: "공고명", value: [{ text: "연구 용역", visible: true }] }], tables: [] }],
        attachments: [], links: [], modalCaptures: url.includes("R26BK1") ? [{
          trigger: { index: 0, tag: "a", label: "발주계획", value: "R26DD12345678", html: "<a>계획</a>" },
          modal: { title: "계획", fields: [{ label: "내용", value: [{ text: "예산", visible: true }] }], tables: [] }
        }] : [] }, relatedNoticeKeys: url.includes("R26BK1") ? ["R26BK2--000"] : [] });
      const job = await startCollection({ start: "2026-10-25", end: "2026-10-25" },
        { storage: "postgres", dataDir: dir, fetcher: fetcher as typeof fetch, scrape });
      const collectionState = await finished(job.id, dir);
      expect(collectionState?.status, JSON.stringify(collectionState?.errors)).toBe("completed");
      expect(await listNotices()).toHaveLength(2);
      const record = await getNoticeRecord("R26BK1--000");
      expect(record?.relatedNoticeKeys).toContain("R26BK2--000");
      expect(record?.orderPlans[0].detail?.sections?.[0].fields[0].value).toEqual([{ text: "예산", visible: true }]);
      const storedJob = await runtime.__g2bPgPool!.query(`SELECT status,state FROM ${schema}.collection_jobs WHERE id=$1`, [job.id]);
      expect(storedJob.rows[0]).toMatchObject({ status: "completed", state: { id: job.id, status: "completed" } });
      const lock = await runtime.__g2bPgPool!.query(`SELECT job_id FROM ${schema}.collection_lock WHERE id=1`);
      expect(lock.rows[0].job_id).toBeNull();
      const related = await getNoticeRecord("R26BK2--000");
      expect(related?.relatedNoticeKeys).toContain("R26BK1--000");
      const summary = await runtime.__g2bPgPool!.query(`SELECT title, amount, posted_at FROM ${schema}.notices WHERE key=$1`, ["R26BK1--000"]);
      expect(summary.rows[0].title).toBe("연구 용역");
      expect(summary.rows[0].amount).toBe("1200");
      const refresh = await startRefresh(["R26BK1--000"], { storage: "postgres", dataDir: dir,
        scrape: async (url) => ({ detail: { sourceUrl: url,
          sections: [{ title: "공고일반", fields: [{ label: "공고명", value: [{ text: "갱신된 용역", visible: true }] }], tables: [] }],
          attachments: [], links: [], modalCaptures: [{
            trigger: { index: 0, tag: "a", label: "발주계획", value: "R26DD12345678", html: "<a>계획</a>" },
            modal: { title: "계획", fields: [{ label: "내용", value: [{ text: "변경된 예산", visible: true }] }], tables: [] }
          }] }, relatedNoticeKeys: [] }) });
      const refreshed = await finished(refresh.id, dir);
      expect(refreshed?.results, JSON.stringify(refreshed?.errors)).toEqual([{ key: "R26BK1--000", status: "succeeded" }]);
      expect((await getNoticeRecord("R26BK1--000"))?.normalized.title.value).toBe("갱신된 용역");
      const refreshedRefs = await runtime.__g2bPgPool!.query(`SELECT detail_key,category FROM ${schema}.notice_independent_refs WHERE notice_key=$1`, ["R26BK1--000"]);
      expect(refreshedRefs.rows, JSON.stringify(refreshed?.errors)).toHaveLength(1);
      expect((await getNoticeRecord("R26BK1--000"))?.orderPlans[0].detail?.sections?.[0].fields[0].value)
        .toEqual([{ text: "예산", visible: true }]);
      const failedRefresh = await startRefresh(["R26BK1--000"], { storage: "postgres", dataDir: dir,
        scrape: async () => { throw new Error("상세 접근 실패"); } });
      expect((await finished(failedRefresh.id, dir))?.detailFailed).toBe(1);
      expect((await getNoticeRecord("R26BK1--000"))?.normalized.title.value).toBe("갱신된 용역");
    } finally {
      process.env.G2B_SERVICE_KEY = originalKey;
      if (originalSchema === undefined) delete process.env.G2B_DB_SCHEMA;
      else process.env.G2B_DB_SCHEMA = originalSchema;
      if (runtime.__g2bPgPool) await runtime.__g2bPgPool.end();
      delete runtime.__g2bPgPool;
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
