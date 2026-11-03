import { randomUUID } from "node:crypto";
import type { DetailQueue } from "./detail-queue";
import type { CollectionJob } from "./collection-job";
import type { CollectionNoticeResult } from "./collection-progress";
import type { DiagnosticState } from "./collection-diagnostics";
import type { MaintenanceInfo } from "./maintenance";

export type DetailSnapshot = {
  result?: CollectionNoticeResult;
  errors?: string[];
  diagnostics?: DiagnosticState["diagnostics"];
  maintenance?: MaintenanceInfo;
};

/** 검증된 선택 대상과 공유 실행 연결을 하나의 접수 트랜잭션으로 확정합니다. */
export async function submitDetailRefresh(queue: DetailQueue, keys: string[]): Promise<CollectionJob> {
  if (!Array.isArray(keys) || keys.length === 0) throw Error("재수집할 공고를 선택하세요.");
  const unique = [...new Set(keys)];
  for (const key of unique) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key) || key.includes(".."))
      throw Error(`잘못된 공고 키: ${key}`);
  }
  const id = randomUUID();
  await queue.transaction(async db => {
    await db.query(`INSERT INTO ${queue.schema}.detail_collection_jobs(id) VALUES($1)`, [id]);
    for (const key of unique) {
      const notice = (await db.query(`SELECT detail FROM ${queue.schema}.notices WHERE key=$1`, [key])).rows[0];
      if (!notice) throw Error(`저장된 공고를 찾을 수 없습니다: ${key}`);
      await queue.enqueueInTransaction(db, { key, jobId: id, source: "manual", purpose: notice.detail ? "reextract" : "initial" });
    }
  });
  return (await getDetailRefresh(queue, id))!;
}

/** 공유 실행들의 진단을 한도와 유형별 합계를 보존하여 합칩니다. */
function mergeDiagnostics(snapshots: DetailSnapshot[]): DiagnosticState["diagnostics"] {
  const merged: NonNullable<DiagnosticState["diagnostics"]> = { events: [], types: {}, overflowCount: 0 };
  for (const { diagnostics } of snapshots) {
    if (!diagnostics) continue;
    merged.events.push(...diagnostics.events);
    merged.overflowCount += diagnostics.overflowCount;
    for (const [key, type] of Object.entries(diagnostics.types)) {
      const old = merged.types[key];
      merged.types[key] = old ? { ...old, count: old.count + type.count,
        firstAt: old.firstAt < type.firstAt ? old.firstAt : type.firstAt,
        lastAt: old.lastAt > type.lastAt ? old.lastAt : type.lastAt } : { ...type };
    }
  }
  merged.events.sort((a, b) => a.at.localeCompare(b.at));
  merged.overflowCount += Math.max(0, merged.events.length - 500);
  merged.events = merged.events.slice(0, 500);
  return Object.keys(merged.types).length ? merged : undefined;
}

/** 요청 작업의 상태를 공유 실행에서 계산하여 작업 JSON의 경쟁 덮어쓰기를 피합니다. */
export async function getDetailRefresh(queue: DetailQueue, id: string): Promise<CollectionJob | null> {
  const job = (await queue.pool.query(`SELECT requested_at FROM ${queue.schema}.detail_collection_jobs WHERE id=$1`, [id])).rows[0];
  if (!job) return null;
  const rows = (await queue.pool.query(`SELECT r.*, (l.owner_token=r.owner_token AND l.expires_at>clock_timestamp()) AS live
    FROM ${queue.schema}.detail_collection_requests q JOIN ${queue.schema}.detail_collection_runs r ON r.id=q.run_id
    CROSS JOIN ${queue.schema}.detail_collection_worker_lease l WHERE q.job_id=$1 AND l.id=1
    ORDER BY q.requested_at,r.id`, [id])).rows;
  const active = rows.filter(row => row.status === "processing" && row.live);
  const waiting = rows.filter(row => row.status === "queued" || (row.status === "processing" && !row.live));
  const done = rows.filter(row => row.status === "succeeded" || row.status === "failed");
  const snapshots: DetailSnapshot[] = rows.map(row => row.progress);
  const results: CollectionNoticeResult[] = rows.map(row => {
    const snapshot = row.progress as DetailSnapshot;
    const pending = row.status === "queued" || (row.status === "processing" && !row.live);
    return { ...(!pending ? snapshot.result : undefined), key: row.notice_key,
      status: row.status === "succeeded" ? "succeeded" : row.status === "failed" ? "failed" : "pending",
      startedAt: !pending && row.started_at ? row.started_at.toISOString() : undefined,
      finishedAt: row.finished_at?.toISOString(), error: row.error ?? snapshot.result?.error };
  });
  const status = active.length ? "running" : waiting.length ? "queued" : "completed";
  return { id, mode: "refresh", queueVersion: 1, status, phase: status === "completed" ? "done" : "detail", range: null,
    startedAt: job.requested_at.toISOString(),
    finishedAt: status === "completed" && done.length ? new Date(Math.max(...done.map(row => row.finished_at.getTime()))).toISOString() : undefined,
    apiCount: 0, apiTotal: 0, apiProcessed: 0, detailTotal: rows.length, detailQueued: waiting.length,
    detailSucceeded: rows.filter(row => row.status === "succeeded").length,
    detailFailed: rows.filter(row => row.status === "failed").length,
    results, errors: snapshots.flatMap(snapshot => snapshot.errors ?? []), diagnostics: mergeDiagnostics(snapshots),
    progress: results.find(result => result.startedAt && !result.finishedAt)?.progress,
    maintenance: waiting.map(row => (row.progress as DetailSnapshot).maintenance).find(Boolean) };
}
