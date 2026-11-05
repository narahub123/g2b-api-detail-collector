import { QUEUE_POLL_INTERVAL_MS } from "@/lib/constants";
/** 하나의 프로세스에서 시작·깨우기·주기 확인을 합치고 실행 Promise를 추적합니다. */
export class DetailRuntime {
  pending: Promise<void> | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private again = false;
  private stopped = false;
  private readonly abort = new AbortController();

  /** 내부 소비 요청이 종료 시점의 선점 중단 신호를 공유하게 합니다. */
  get signal(): AbortSignal { return this.abort.signal; }

  /** 소비 루프와 관측 가능한 오류 처리기를 주입합니다. */
  constructor(private readonly run: (signal: AbortSignal) => Promise<unknown>,
    private readonly onError: (error: unknown) => void = error => console.error("상세 큐 실행 실패:", error)) {}

  /** 중복 초기화를 피하고 시작 직후와 30초마다 복구·선점을 시도합니다. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.wake(), QUEUE_POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.wake();
  }

  /** 실행 종료 직전의 새 요청도 다시 검사하도록 깨우기를 합칩니다. */
  wake(): void {
    if (this.stopped) return;
    if (this.pending) { this.again = true; return; }
    // 첫 실행은 동기적으로 시작하지만 작업 Promise는 반드시 추적합니다.
    this.pending = this.drain().finally(() => { this.pending = null; });
  }

  /** 깨우기가 들어온 동안만 반복하고 실행 오류가 다음 재개를 막지 않게 합니다. */
  private async drain(): Promise<void> {
    do {
      this.again = false;
      try { await this.run(this.abort.signal); } catch (error) { this.onError(error); }
    } while (this.again && !this.stopped);
  }

  /** 새 선점을 중지하고 현재 공고의 저장·정리가 끝날 때까지 기다립니다. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
}
