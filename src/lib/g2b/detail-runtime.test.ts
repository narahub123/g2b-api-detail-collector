import { QUEUE_POLL_INTERVAL_MS } from "@/lib/constants";
import { afterEach, expect, it, vi } from "vitest";
import { DetailRuntime } from "./detail-runtime";

afterEach(() => vi.useRealTimers());

it("실행 중 깨우기를 잃지 않고 같은 프로세스의 중복 소비기를 막습니다", async () => {
  let release!: () => void;
  let calls = 0;
  const runtime = new DetailRuntime(async () => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
  });
  runtime.wake();
  runtime.wake();
  expect(calls).toBe(1);
  release();
  await runtime.pending;
  expect(calls).toBe(2);
  await runtime.stop();
});

it("시작 시 복구하고 30초마다 재확인하며 종료 뒤에는 깨우지 않습니다", async () => {
  vi.useFakeTimers();
  const run = vi.fn(async () => undefined);
  const runtime = new DetailRuntime(run);
  runtime.start();
  runtime.start();
  await runtime.pending;
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(QUEUE_POLL_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(2);
  await runtime.stop();
  runtime.wake();
  await vi.advanceTimersByTimeAsync(QUEUE_POLL_INTERVAL_MS);
  expect(run).toHaveBeenCalledTimes(2);
});

it("실행 오류를 관측하고 다음 깨우기에서 다시 시작합니다", async () => {
  let count = 0;
  const errors: unknown[] = [];
  const runtime = new DetailRuntime(async () => { if (++count === 1) throw new Error("연결 중단"); }, error => errors.push(error));
  runtime.wake();
  await runtime.pending;
  expect(errors).toHaveLength(1);
  runtime.wake();
  await runtime.pending;
  expect(count).toBe(2);
  await runtime.stop();
});
