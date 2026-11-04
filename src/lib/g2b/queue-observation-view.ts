import {
  appendDiagnosticEntry,
  type DiagnosticEntry,
  type DiagnosticState,
} from "./collection-diagnostics";
import {
  collectionDetailStages,
  collectionDetailSteps,
  type CollectionDetailStat,
} from "./collection-detail-steps";
import type {
  CollectionTimings,
  CollectionTimingOutcome,
} from "./collection-timings";
import type { CollectionStage } from "./collection-progress";
import type { QueueObservation } from "./queue-observation";
import type { QueueObservationState } from "./queue-observation-store";

/** 여러 공유 실행이나 스냅샷에 반복된 트랜잭션은 한 번만 읽습니다. */
export function getQueueObservations(
  snapshots: readonly QueueObservationState[],
): QueueObservation[] {
  return uniqueObservations(
    snapshots.flatMap((snapshot) =>
      Object.values(snapshot.queueObservations ?? {}),
    ),
  );
}

/** 원본 기록 순서를 유지하여 같은 식별자의 최초 종료 관측만 선택합니다. */
function uniqueObservations(
  values: readonly QueueObservation[],
): QueueObservation[] {
  const observations = new Map<string, QueueObservation>();
  for (const observation of values) {
    if (!observation?.context?.transactionId || !observation.timings) continue;
    if (!observations.has(observation.context.transactionId))
      observations.set(observation.context.transactionId, observation);
  }
  return [...observations.values()];
}

/** 세부 집계의 누적·최대·결과별 횟수를 동일한 방식으로 합칩니다. */
function addStat(
  target: CollectionDetailStat,
  source: CollectionDetailStat,
): void {
  target.elapsedMs += source.elapsedMs;
  target.count += source.count;
  target.maxMs = Math.max(target.maxMs, source.maxMs);
  for (const [outcome, count] of Object.entries(source.outcomes)) {
    const key = outcome as keyof CollectionDetailStat["outcomes"];
    target.outcomes[key] = (target.outcomes[key] ?? 0) + count!;
  }
}

/** 종료하지 못한 단계나 세부 구간이 남아 있는지 확인합니다. */
function hasOpenTiming(value: CollectionTimings): boolean {
  return (
    !!value.active ||
    Object.values(value.details ?? {}).some((group) => group.active.length > 0)
  );
}

/** 허용된 세부 단계와 항목만 복사하고 열린 구간은 필요 시 마지막 저장값으로 마감합니다. */
function addDetails(
  target: CollectionTimings,
  source: CollectionTimings,
  closeActive = false,
): void {
  for (const stage of collectionDetailStages) {
    const group = source.details?.[stage];
    if (!group) continue;
    const merged = ((target.details ??= {})[stage] ??= {
      steps: {},
      active: [],
    });
    for (const [name, stat] of Object.entries(group.steps)) {
      if (!stat || !Object.hasOwn(collectionDetailSteps, name)) continue;
      const step = name as keyof typeof collectionDetailSteps;
      addStat(
        (merged.steps[step] ??= {
          elapsedMs: 0,
          count: 0,
          maxMs: 0,
          outcomes: {},
        }),
        stat,
      );
    }
    for (const active of group.active) {
      if (!closeActive) {
        if (!merged.active.some((value) => value.id === active.id))
          merged.active.push(structuredClone(active));
      } else {
        const outcome =
          source.outcome === "interrupted" ? "interrupted" : "incomplete";
        addStat(
          (merged.steps[active.step] ??= {
            elapsedMs: 0,
            count: 0,
            maxMs: 0,
            outcomes: {},
          }),
          {
            elapsedMs: active.elapsedMs,
            count: 1,
            maxMs: active.elapsedMs,
            outcomes: { [outcome]: 1 },
          },
        );
      }
    }
  }
}

/** 큐 세부 시간만 연결하여 기존 단계 총시간에 중첩 측정값을 더하지 않습니다. */
export function mergeQueueTimings(
  base: CollectionTimings | undefined,
  observations: readonly QueueObservation[],
  outcome: CollectionTimingOutcome,
): CollectionTimings | undefined {
  const merged: CollectionTimings = base
    ? structuredClone(base)
    : { totals: {}, outcome };
  merged.outcome = outcome;
  if (base && outcome === "interrupted" && hasOpenTiming(base))
    merged.estimated = true;
  for (const value of uniqueObservations(observations))
    addDetails(merged, value.timings);
  return base || Object.keys(merged.details ?? {}).length ? merged : undefined;
}

/** 작업 전체에는 공고별 저장 작업량을 합치며 벽시계 대기나 큐 중첩 시간은 추가하지 않습니다. */
export function aggregateCollectionTimings(
  sources: readonly (CollectionTimings | undefined)[],
  observations: readonly QueueObservation[],
  outcome: CollectionTimingOutcome,
): CollectionTimings | undefined {
  const base: CollectionTimings = { totals: {}, outcome, aggregated: true };
  let measured = false;
  for (const value of sources) {
    if (!value) continue;
    measured = true;
    for (const [stage, elapsed] of Object.entries(value.totals))
      base.totals[stage as CollectionStage] =
        (base.totals[stage as CollectionStage] ?? 0) + elapsed!;
    if (value.active)
      base.totals[value.active.stage] =
        (base.totals[value.active.stage] ?? 0) + value.active.elapsedMs;
    if (
      value.estimated ||
      (value.outcome === "interrupted" && hasOpenTiming(value))
    )
      base.estimated = true;
    addDetails(base, value, value.outcome !== "running");
  }
  const merged = mergeQueueTimings(
    measured ? base : undefined,
    observations,
    outcome,
  );
  if (merged) merged.aggregated = true;
  return merged;
}

/** JSONB에서 키 순서가 달라져도 같은 원본 오류를 대조합니다. */
function errorIdentity(entry: DiagnosticEntry): string {
  return JSON.stringify(
    [entry.severity, entry.diagnostic ?? entry.error],
    (_key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        );
      return value;
    },
  );
}

/** 원본 오류의 숫자 차이를 정규화하여 동일 유형을 식별합니다. */
function diagnosticSignature(entry: DiagnosticEntry): string {
  return JSON.stringify([
    entry.severity,
    entry.error.code ?? "",
    entry.error.message
      .replace(/\b\d+\b/g, "#")
      .replace(/\s+/g, " ")
      .trim(),
  ]);
}

/** 기존 진단 발생 횟수를 보존하고 누락된 종료 관측만 복원합니다. */
export function mergeQueueDiagnostics(
  base: DiagnosticState,
  observations: readonly QueueObservation[],
  key?: string,
): DiagnosticState["diagnostics"] {
  const state: DiagnosticState = structuredClone(
    base.diagnostics ? { diagnostics: base.diagnostics } : {},
  );

  const remaining = new Map<string, number>();
  const visible = new Map<string, number>();
  const overflow = new Map<string, number>();

  // 개별 기록은 스택·원인·잠금 대상을 포함한 원본으로 대조합니다.
  for (const entry of state.diagnostics?.events ?? []) {
    const identity = errorIdentity(entry);
    remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
    const signature = diagnosticSignature(entry);
    visible.set(signature, (visible.get(signature) ?? 0) + 1);
  }
  const total = new Map<string, number>();
  for (const type of Object.values(state.diagnostics?.types ?? {})) {
    const signature = diagnosticSignature(type.representative);
    total.set(signature, (total.get(signature) ?? 0) + type.count);
  }
  // 원본을 알 수 없는 한도 밖의 횟수만 유형별 대조에 사용합니다.
  for (const [signature, count] of total)
    overflow.set(signature, Math.max(0, count - (visible.get(signature) ?? 0)));

  const unmatched: DiagnosticEntry[] = [];
  for (const observation of uniqueObservations(observations)) {
    for (const entry of observation.diagnostics?.events ?? []) {
      const identity = errorIdentity(entry);
      const count = remaining.get(identity) ?? 0;
      if (count > 0) {
        remaining.set(identity, count - 1);
        continue;
      }
      unmatched.push(entry);
    }
  }

  // 모든 정확한 일치를 먼저 확정해야 관측 순서가 초과 횟수의 사용에 영향을 주지 않습니다.
  for (const entry of unmatched) {
    const signature = diagnosticSignature(entry);
    const count = overflow.get(signature) ?? 0;
    if (count > 0) { overflow.set(signature, count - 1); continue; }
    appendDiagnosticEntry(state, {
      ...structuredClone(entry),
      target: entry.target ?? (key ? { key } : undefined),
    });
  }

  return state.diagnostics;
}
