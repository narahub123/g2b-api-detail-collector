import type pg from "pg";
import { serializeError } from "../error-diagnostics";
import type { QueueObservation } from "./queue-observation";

export type QueueObservationState = { queueObservations?: Record<string, QueueObservation> };

/** 업무 스냅샷 교체 시에도 DB가 관리하는 종료 관측 기록은 보존합니다.
 * @param parameter 기존 스냅샷 인자이며 empty는 업무 진행만 비우는 복구 경로에 사용합니다.
 */
export function queueSnapshotUpdate(column: "producer_state" | "progress", parameter: "$2" | "$5" | "empty"): string {
  const incoming = parameter === "empty" ? "'{}'::jsonb" : `COALESCE(${parameter}::jsonb,${column})`;
  return `((${incoming}) - 'queueObservations') || CASE WHEN ${column} ? 'queueObservations'
    THEN jsonb_build_object('queueObservations',${column}->'queueObservations') ELSE '{}'::jsonb END`;
}

/** 종료한 트랜잭션의 관측 한 건만 원자적으로 병합하며 중복 ID는 다시 반영하지 않습니다.
 * @remarks 진단 전용 잠금 제한은 이 문장 안에서만 적용하고 업무 연결의 설정은 바꾸지 않습니다.
 */
export async function saveQueueObservation(pool: Pick<pg.Pool, "query">, schema: string, observation: QueueObservation): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw Error("잘못된 DB 스키마 이름입니다.");
  const { runId, jobId, transactionId } = observation.context;
  const table = runId ? "detail_collection_runs" : "detail_collection_jobs";
  const column = runId ? "progress" : "producer_state";
  const id = runId ?? jobId;
  if (!id) {
    // 전역 소비기 임대처럼 귀속 대상을 알 수 없는 오류는 임의 작업에 연결하지 않습니다.
    if (observation.diagnostics) throw Error("진단을 저장할 작업 또는 실행 식별자가 없습니다.");
    return;
  }
  const config: pg.QueryConfig & { query_timeout: number } = {
    text: `/* queue-observation */ WITH settings AS MATERIALIZED (
      SELECT set_config('lock_timeout','1s',true)
    ), saved AS (
      UPDATE ${schema}.${table} SET ${column}=jsonb_set(COALESCE(${column},'{}'::jsonb),'{queueObservations}',
        COALESCE(${column}->'queueObservations','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb),true)
      FROM settings WHERE id=$1 AND NOT (COALESCE(${column}->'queueObservations','{}'::jsonb) ? $2::text)
      RETURNING id
    ) SELECT EXISTS(SELECT 1 FROM saved) OR EXISTS(SELECT 1 FROM ${schema}.${table} WHERE id=$1) AS found`,
    values: [id, transactionId, JSON.stringify(observation)],
    query_timeout: 5000,
  };
  const result = await pool.query<{ found: boolean }>(config);
  if (result.rows[0]?.found === false) throw Error("진단을 저장할 작업 또는 실행 행이 없습니다.");
}

/** 진단 저장 실패도 기존 정제기를 거쳐 원본 진단과 함께 서버 로그에 남깁니다. */
export function logQueueObservationFailure(observation: QueueObservation, error: unknown): void {
  try {
    console.error("queue-observation-save", serializeError({ name: "QueueObservationSaveError",
      message: "큐 종료 계측·진단을 저장하지 못했습니다.", cause: error, observation }));
  } catch { /* 로그 출력 장애도 이미 확정한 업무 결과를 바꾸지 않습니다. */ }
}
