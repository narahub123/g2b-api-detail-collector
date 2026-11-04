import pg from "pg";
import { DocumentQueue } from "../queue";
import { PdfDispatchState } from "../dispatch-state";
import type { DispatchClaim } from "../dispatch-state";
import { runPdfDispatch } from "../dispatch";
import type { DispatchResponse } from "../dispatch";
import { createWebPdfDispatcher } from "../dispatch-runtime";

const boundary=process.env.DISPATCH_TEST_BOUNDARY;

/** 부모가 실제 종료할 때까지 살아 있으면서 지정한 경계에 도달했음을 알립니다. */
async function hold(extra: Record<string,unknown> = {}): Promise<never> {
  process.send?.({type:"held",boundary,...extra});
  return new Promise<never>(()=>undefined);
}

/** 호출권 커밋 후와 성공 응답 수신 후의 DB 확인 직전만 멈춥니다. */
class HeldDispatchState extends PdfDispatchState {
  /** 실제 호출권을 확보한 다음 외부 호출이 시작되기 전에 멈춥니다. */
  override async claim(repository: string): Promise<DispatchClaim> {
    const result=await super.claim(repository);
    if(boundary==="claimed"&&result.reason==="claimed")await hold({generation:result.generation});
    return result;
  }
  /** 성공 응답은 실제 파서로 확인하되 DB 확인 기록을 쓰기 전에 멈춥니다. */
  override async finish(repository: string,token: string,generation: string,response: DispatchResponse): Promise<boolean> {
    if(boundary==="accepted"&&response.accepted)await hold({generation,httpStatus:response.httpStatus,runUrl:response.runUrl});
    return super.finish(repository,token,generation,response);
  }
}

/** 외부 GitHub 주소는 검증만 하고 HTTP 전송은 테스트용 루프백 서버로만 보냅니다. */
async function main(): Promise<void> {
  const repository=process.env.PDF_DISPATCH_REPOSITORY!;
  const key=process.env.DISPATCH_TEST_NOTICE_KEY!,fileNo=process.env.DISPATCH_TEST_FILE_NO!;
  const endpoint=new URL(process.env.DISPATCH_TEST_ENDPOINT!);
  if(endpoint.protocol!=="http:"||endpoint.hostname!=="127.0.0.1"||endpoint.pathname!=="/dispatch"||!endpoint.port||endpoint.username||endpoint.password) {
    throw new Error("테스트 HTTP 주소를 확인하세요.");
  }
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:10_000,query_timeout:15_000});
  try {
    const queue=new DocumentQueue(pool,process.env.G2B_DB_SCHEMA);
    if(boundary!=="resume" && boundary!=="resume-web")await queue.enqueue(key,fileNo,1,"automatic");
    if(boundary==="registered")await hold();
    const nativeFetch=fetch;
    const fetcher: typeof fetch=async(input,init)=>{
      if(String(input)!==`https://api.github.com/repos/${repository}/actions/workflows/pdf-extract.yml/dispatches`) {
        throw new Error("예상하지 않은 외부 호출입니다.");
      }
      return nativeFetch(endpoint,init);
    };
    if(boundary==="resume-web") {
      process.env.PDF_WEB_DISPATCH_ENABLED="true";process.env.DETAIL_COLLECTION_QUEUE_ENABLED="true";
      process.env.PDF_DISPATCH_TOKEN="dispatch-crash-test-token";
      globalThis.fetch=fetcher;
      const runtime=createWebPdfDispatcher(pool,queue.schema);
      if(!runtime)throw new Error("웹 테스트 조정기가 비활성입니다.");
      try {runtime.wake();await runtime.finish();}
      finally {globalThis.fetch=nativeFetch;}
      process.send?.({type:"result"});return;
    }
    const result=await runPdfDispatch(new HeldDispatchState(pool,queue.schema),{repository,token:"dispatch-crash-test-token",fetcher});
    process.send?.({type:"result",result});
  } finally { await pool.end(); }
}

// 대기 중인 Promise만으로 프로세스가 먼저 종료되지 않도록 테스트 수명을 유지합니다.
const alive=setInterval(()=>undefined,1_000);
main().then(()=>{clearInterval(alive);process.exit(0);}).catch(()=>{clearInterval(alive);process.send?.({type:"failed"});process.exit(1);});
