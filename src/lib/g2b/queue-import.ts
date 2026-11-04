import { randomUUID } from "node:crypto";
import type { DetailQueue } from "./detail-queue";
import { inspectLegacyImport, readLegacyImport } from "./queue-rollout";

/** 실행 중인 수집과 대상 변동을 차단한 뒤 확인된 한 묶음만 원자적으로 이관합니다. */
export async function applyLegacyImport(queue: DetailQueue, expectedDigest: string, limit = 100): Promise<{ imported: number; jobId?: string }> {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw Error("사전 보고서의 대상 지문을 지정하세요.");
  const before = await inspectLegacyImport(queue.pool, queue.schema, limit);
  if (!before.ready) throw Error("0014~0017 상세 큐 스키마를 먼저 준비하세요.");
  return queue.transaction(async db => {
    await db.query(`SELECT id FROM ${queue.schema}.detail_collection_producer_lease WHERE id=1 FOR UPDATE`);
    await queue.lockMutation(db);
    const { report, candidates } = await readLegacyImport(db, queue.schema, limit);
    if (report.blockers.length) throw Error(report.blockers.join(" · "));
    if (report.digest !== expectedDigest) throw Error("이관 대상이 변경되었습니다. 사전 보고서를 다시 확인하세요.");
    const selected = candidates.slice(0, limit);
    if (!selected.length) return { imported: 0 };
    const jobId = randomUUID();
    await db.query(`INSERT INTO ${queue.schema}.detail_collection_jobs(id,mode,source,producer_status,producer_state)
      VALUES($1,'collection','automatic','completed',$2::jsonb)`, [jobId, JSON.stringify({ imported: true, apiCount: 0, apiProcessed: 0, apiTotal: 0, errors: [] })]);
    for (const candidate of selected) {
      const run = await queue.enqueueInTransaction(db, { key: candidate.key, jobId, source: "automatic", purpose: candidate.purpose });
      await db.query(`INSERT INTO ${queue.schema}.detail_collection_targets(job_id,notice_key) VALUES($1,$2)`, [jobId, candidate.key]);
      await db.query(`INSERT INTO ${queue.schema}.detail_collection_imports(notice_key,job_id,run_id,purpose)
        VALUES($1,$2,$3,$4)`, [candidate.key, jobId, run.id, candidate.purpose]);
    }
    return { imported: selected.length, jobId };
  });
}
