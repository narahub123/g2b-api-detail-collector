import { DetailQueue } from "./detail-queue";
import { DetailRuntime } from "./detail-runtime";
import { consumeCollectionQueue } from "./collection-queue-worker";
import { getPool } from "./postgres-store";
import { serializeError } from "../error-diagnostics";
import { randomUUID } from "node:crypto";
import process from "node:process";

// 계측 초기화와 요청 번들이 서로 다른 전역 객체를 사용해도 같은 Node 프로세스 상태를 공유합니다.
const state = process as typeof process & { __g2bDetailRuntime?: DetailRuntime; __g2bDetailToken?: string; __g2bDetailWork?: Promise<number> };

/** 운영 전환 전에는 명시적으로 활성화한 검사 환경에서만 새 경로를 사용합니다. */
export function detailQueueEnabled(): boolean {
  return process.env.DETAIL_COLLECTION_QUEUE_ENABLED === "true";
}

/** API 생산과 분리된 상세 소비기를 만들되 구 버전 수집의 호환 잠금은 유지합니다. */
export function webDetailQueue(): DetailQueue {
  return new DetailQueue(getPool(), undefined, { legacyCollectionLock: true, collectionMode: true });
}

/** 개발 재로딩에서도 프로세스당 하나의 소비기와 종료 처리기를 유지합니다. */
export function startDetailWebRuntime(): DetailRuntime | null {
  if (!detailQueueEnabled() || !process.env.DATABASE_URL) return null;
  if (!state.__g2bDetailRuntime) {
    state.__g2bDetailToken = randomUUID();
    const runtime = new DetailRuntime(async () => {
      // 내부 요청의 after에 소비를 연결하여 Next가 종료 시 실행을 기다리게 합니다.
      // 응답은 즉시 끝내므로 긴 큐 처리로 HTTP 응답 제한에 걸리지 않습니다.
      const response = await fetch(`http://127.0.0.1:${process.env.PORT || "3000"}/api/internal/detail-consumer`, {
        method: "POST", headers: { authorization: `Bearer ${state.__g2bDetailToken}` }, cache: "no-store",
      });
      if (!response.ok) throw Error("상세 소비 요청을 완료하지 못했습니다.");
      await response.json();
      await state.__g2bDetailWork;
    },
      error => console.error("상세 큐 실행 실패:", serializeError(error)));
    state.__g2bDetailRuntime = runtime;
    /** 종료 요청 이후의 새 공고 선점을 막고 현재 실행의 정리를 시도합니다. */
    const stop = () => { void runtime.stop().catch(error => console.error("상세 큐 종료 실패:", serializeError(error))); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    runtime.start();
  }
  return state.__g2bDetailRuntime;
}

/** 인증된 내부 요청의 after 수명에 소비 Promise를 등록하며 응답은 즉시 반환하게 합니다. */
export function scheduleDetailWebRequest(authorization: string | null, schedule: (work: () => Promise<void>) => void): boolean {
  if (!detailQueueEnabled() || !state.__g2bDetailToken || authorization !== `Bearer ${state.__g2bDetailToken}`) return false;
  if (state.__g2bDetailWork) {
    const running = state.__g2bDetailWork;
    schedule(async () => { await running; });
    return true;
  }
  let resolve!: (count: number) => void;
  let reject!: (error: unknown) => void;
  const work = new Promise<number>((ok, fail) => { resolve = ok; reject = fail; });
  state.__g2bDetailWork = work;
  // after가 HTTP 응답보다 먼저 실패해도 처리되지 않은 거부가 발생하지 않게 합니다.
  void work.catch(() => undefined);
  schedule(async () => {
    try { resolve(await consumeCollectionQueue(webDetailQueue(), { signal: state.__g2bDetailRuntime?.signal })); }
    catch (error) { reject(error); console.error("상세 소비 요청 실패:", serializeError(error)); }
    finally { if (state.__g2bDetailWork === work) state.__g2bDetailWork = undefined; }
  });
  return true;
}

/** 접수가 커밋된 뒤 소비기를 깨우며 응답 수명과 실행 Promise를 분리합니다. */
export function wakeDetailWebRuntime(): void {
  startDetailWebRuntime()?.wake();
}
