import { QUEUE_POLL_INTERVAL_MS } from "@/lib/constants";
import pg from "pg";
import { dispatchRepository, normalizeDispatchRepository, PdfDispatchState } from "./dispatch-state";
import { runPdfDispatch } from "./dispatch";
import { PDF_DB_QUERY_TIMEOUT_MS } from "./constants";

/** 웹·일반 CLI와 다른 브랜치를 제외하고 승인된 수집 Actions에서만 호출을 허용합니다. */
export function actionsDispatchAllowed(env: Record<string,string|undefined> = process.env): boolean {
  const repository=dispatchRepository(env);
  return !!repository && env.GITHUB_ACTIONS==="true" && env.GITHUB_REF==="refs/heads/main"
    && normalizeDispatchRepository(env.GITHUB_REPOSITORY)===repository
    && env.GITHUB_WORKFLOW_REF?.toLowerCase()===`${repository}/.github/workflows/collect.yml@refs/heads/main`;
}

/** 웹 서버의 별도 승인과 서버 전용 인증이 갖춰진 경우에만 실행 요청을 허용합니다. */
export function webDispatchAllowed(env: Record<string,string|undefined> = process.env): boolean {
  return env.PDF_WEB_DISPATCH_ENABLED === "true" && env.DETAIL_COLLECTION_QUEUE_ENABLED === "true"
    && !!env.DATABASE_URL && !!dispatchRepository(env) && env.GITHUB_ACTIONS !== "true"
    && !!env.PDF_DISPATCH_TOKEN?.trim() && !/[\r\n]/.test(env.PDF_DISPATCH_TOKEN);
}

/** 수집 중 주기 점검과 공고 완료 신호를 합치고 종료 시 마지막 점검까지 기다립니다. */
export class PdfDispatchRuntime {
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private again=false;
  private stopped=false;
  private ending?:Promise<void>;
  /** 실패를 내부에서 처리하는 단일 점검과 수집의 종료 신호를 공유합니다. */
  constructor(private readonly pulse: ()=>Promise<unknown>,private readonly signal?:AbortSignal,
    private readonly close?:()=>Promise<void>) {}
  /** 시작 직후와 30초마다 확인하되 같은 프로세스의 호출은 겹치지 않습니다. */
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer=setInterval(()=>this.wake(),QUEUE_POLL_INTERVAL_MS);this.timer.unref?.();this.wake();
  }
  /** 신규 등록은 다음 주기까지 기다리지 않고 현재 점검 또는 후속 점검에 합칩니다. */
  wake(): void {
    if (this.stopped || this.signal?.aborted) return;
    if (this.pending) {this.again=true;return;}
    this.pending=this.drain().finally(()=>{this.pending=undefined;});
  }
  /** 외부 실행 요청 오류가 수집 실행을 실패시키지 않도록 점검 경계에서 처리합니다. */
  private async drain(): Promise<void> {
    do {
      this.again=false;
      try {await this.pulse();} catch {console.warn("PDF 실행 요청 점검을 완료하지 못했습니다. 다음 실행에서 재개합니다.");}
    } while (this.again && !this.stopped && !this.signal?.aborted);
  }
  /** 5분 제한을 우회하지 않고 마지막 확인과 진행 중 호출의 정리를 기다립니다. */
  finish(): Promise<void> {
    return this.ending??=this.finishOnce();
  }
  /** 종료 점검과 전용 연결 풀 정리는 여러 종료 요청에서도 한 번만 수행합니다. */
  private async finishOnce(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer=undefined;
    this.wake();await this.pending;this.stopped=true;
    try{await this.close?.();}catch{console.warn("PDF 실행 요청 연결 정리를 완료하지 못했습니다.");}
  }
}

/** Actions 전용 인증을 서버 실행에서만 읽고 공통 DB 조정기에 연결합니다. */
export function createActionsPdfDispatcher(pool: pg.Pool,schema: string,signal?:AbortSignal): PdfDispatchRuntime | null {
  if (!actionsDispatchAllowed()) return null;
  return createPdfDispatcher(pool,schema,signal);
}

/** 웹의 주기 점검과 공고 완료 신호를 Actions와 같은 저장소별 DB 상태에 연결합니다. */
export function createWebPdfDispatcher(pool: pg.Pool,schema: string,signal?:AbortSignal): PdfDispatchRuntime | null {
  if (!webDispatchAllowed()) return null;
  return createPdfDispatcher(pool,schema,signal);
}

/** 실행 환경에 관계없이 같은 호출 제한과 전용 연결 풀을 사용합니다. */
function createPdfDispatcher(pool: pg.Pool,schema: string,signal?:AbortSignal): PdfDispatchRuntime {
  const repository=dispatchRepository()!;
  // 수집의 기존 연결 제한을 바꾸지 않고 조정기의 연결·쿼리 대기만 제한합니다.
  const dispatchPool=new pg.Pool({...pool.options,max:1,connectionTimeoutMillis:10_000,query_timeout:PDF_DB_QUERY_TIMEOUT_MS});
  const store=new PdfDispatchState(dispatchPool,schema);
  return new PdfDispatchRuntime(async()=>{
    const result=await runPdfDispatch(store,{repository,token:process.env.PDF_DISPATCH_TOKEN??"",signal});
    if (result.attempted || ["invalid_configuration","db_error"].includes(result.reason)) {
      console.log(JSON.stringify({operation:"pdf-progress-dispatch",...result}));
    }
  },signal,()=>dispatchPool.end());
}
