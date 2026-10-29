import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { chromium } from "playwright-core";
import { getDocumentPool } from "../src/lib/documents/pool";
import { DocumentQueue } from "../src/lib/documents/queue";
import { LocalWake, runBatch } from "../src/lib/documents/worker";

const token=process.env.PDF_WORKER_TOKEN;
if(process.env.PDF_WORKER_ENABLED!=="true")throw new Error("PDF_WORKER_ENABLED=true로 로컬 작업기를 명시적으로 활성화하세요.");
if(!token || token.length<32)throw new Error("PDF_WORKER_TOKEN에 32자 이상 토큰을 설정하세요.");
process.env.G2B_CHROME_PATH ||= chromium.executablePath();
const pool=getDocumentPool(),store=new DocumentQueue(pool),shutdown=new AbortController();
let last:unknown=null;
const wake=new LocalWake(async()=>{
  try { last=await runBatch(store,{mode:"local",signal:shutdown.signal});console.log(JSON.stringify({operation:"pdf-local-batch",...last as object})); }
  catch { last={error:"PDF 배치가 실패했습니다. 미완료 실행은 임대 복구 대상입니다."};console.error(JSON.stringify(last)); }
});
const server=createServer((request,response)=>{
  /** 토큰·본문·DB 연결 정보는 응답과 로그에 포함하지 않습니다. */
  const reply=(status:number,body:object)=>{response.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});response.end(JSON.stringify(body));};
  const actual=Buffer.from(request.headers.authorization??""),expected=Buffer.from(`Bearer ${token}`);
  if(actual.length!==expected.length || !timingSafeEqual(actual,expected)){reply(401,{error:"작업 서비스 인증 실패"});return;}
  if(request.method==='GET' && request.url==='/health'){reply(200,{ready:true,busy:!!wake.running,last});return;}
  if(request.method==='POST' && request.url==='/wake'){
    if(shutdown.signal.aborted){reply(503,{error:"작업기가 종료 중입니다."});return;}
    void wake.wake();reply(202,{accepted:true});return;
  }
  reply(404,{error:"지원하지 않는 작업입니다."});
});
/** 새 요청을 막고 현재 자식 종료·임대 해제 뒤 DB 연결을 닫습니다. */
async function stop(){shutdown.abort();server.close();await wake.running;await pool.end();}
process.once("SIGTERM",()=>void stop());process.once("SIGINT",()=>void stop());
server.listen(8788,process.env.PDF_WORKER_HOST||"127.0.0.1",()=>void wake.wake());
