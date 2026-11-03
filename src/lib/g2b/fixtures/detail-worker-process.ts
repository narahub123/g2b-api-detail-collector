import pg from "pg";
import { DetailQueue } from "../detail-queue";
import { consumeDetails } from "../detail-worker";

/** 실제 강제 종료 검사에서 외부 나라장터 호출 없이 소비 프로세스를 실행합니다. */
async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const queue = new DetailQueue(pool, process.env.G2B_DB_SCHEMA, { legacyCollectionLock: true });
    await consumeDetails(queue, { scrape: async url => {
      if (process.env.DETAIL_TEST_HOLD === "true") {
        process.send?.("opened");
        await new Promise<void>(() => undefined);
      }
      return { detail: { sourceUrl: url, attachments: [], links: [] }, relatedNoticeKeys: [] };
    } });
  } finally { await pool.end(); }
}

main().then(() => process.exit(0)).catch(() => process.exit(1));
