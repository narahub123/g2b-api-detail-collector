import {DocumentError} from './contract';
import {guardDocuments} from './access';
import {DocumentStore} from './store';
import {DocumentQueue} from './queue';
import {getDocumentPool} from './pool';

type RouteIds={documentId?:string;runId?:string;page?:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** DB에 접수한 요청을 취소하지 않고 로컬 작업기에 실행 신호만 보냅니다. */
export async function wakeDocumentWorker():Promise<{awake:boolean}>{
 try{
  const token=process.env.PDF_WORKER_TOKEN;
  const url=new URL(process.env.PDF_WORKER_URL||'http://127.0.0.1:8788');
  if(!token||token.length<32||url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)return {awake:false};
  const response=await fetch(new URL('/wake',url),{method:'POST',headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(3000)});
  return {awake:response.status===202};
 }catch{return {awake:false};}
}
/** 소속·페이지·출처를 검증하고 서버 저장소와 작업기 신호를 연결합니다. */
export function createDocumentApi(store:DocumentStore,queue:DocumentQueue,wake=wakeDocumentWorker){
 return async(request:Request,ids:RouteIds={})=>{
  /** 모든 응답은 캐시하지 않으며 작업기 내부 정보는 포함하지 않습니다. */
  const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  try{
   guardDocuments(request);
   const url=new URL(request.url);let key=url.searchParams.get('key');
   if(request.method==='POST'){
    const text=await request.text();if(Buffer.byteLength(text)>4096)throw new DocumentError('요청이 너무 큽니다.',413);
    let body;try{body=JSON.parse(text);}catch{throw new DocumentError('요청 JSON을 확인하세요.');}
    if(key&&key!==body?.key)throw new DocumentError('공고 식별자가 일치하지 않습니다.');key=body?.key;
   }
   if(typeof key!=='string'||!/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key)||key.includes('..'))throw new DocumentError('공고 식별자를 확인하세요.');
   for(const value of [ids.documentId,ids.runId])if(value!==undefined&&!uuid.test(value))throw new DocumentError('문서 또는 실행 ID를 확인하세요.');
   if(request.method==='POST'){
    if(!ids.documentId||ids.runId)throw new DocumentError('추출 요청 경로를 확인하세요.');
    const file=await store.document(key,ids.documentId);
    const run=await queue.enqueue(key,file.file_no,file.seq,'manual');
    const result=await wake().catch(()=>({awake:false}));return reply({id:run.id,...result},run.reused?200:202);
   }
   if(!ids.documentId)return reply(await store.list(key));
   if(ids.page!==undefined){
    if(!ids.runId||!/^\d+$/.test(ids.page)||Number(ids.page)<1||Number(ids.page)>500)throw new DocumentError('페이지 번호를 확인하세요.');
    const page=await store.page(key,ids.documentId,ids.runId,Number(ids.page));if(!page)throw new DocumentError('저장된 페이지를 찾을 수 없습니다.',404);return reply(page);
   }
   if(ids.runId){const run=await store.run(key,ids.documentId,ids.runId);if(!run)throw new DocumentError('해당 공고의 실행 기록을 찾을 수 없습니다.',404);return reply(run);}
   const limitString=url.searchParams.get('limit')??'20';if(!/^\d+$/.test(limitString)||Number(limitString)<1||Number(limitString)>20)throw new DocumentError('이력 조회 개수를 확인하세요.');
   let cursor:{at:string;id:string}|null=null;const encoded=url.searchParams.get('cursor');
   if(encoded){try{if(encoded.length>256)throw new Error();const decoded=JSON.parse(Buffer.from(encoded,'base64url').toString());if(typeof decoded.at!=='string'||!Number.isFinite(Date.parse(decoded.at))||!uuid.test(decoded.id))throw new Error();cursor=decoded;}catch{throw new DocumentError('이력 cursor를 확인하세요.');}}
   return reply(await store.history(key,ids.documentId,Number(limitString),cursor));
  }catch(error){return reply({error:error instanceof DocumentError?error.message:'PDF 요청을 처리하지 못했습니다. DB 설정을 확인하세요.'},error instanceof DocumentError?error.status:503);}
 };
}
/** 라우트에서 활성화 검사보다 먼저 DB 연결을 만들지 않습니다. */
export async function documentApi(request:Request,ids:RouteIds={}){
 try{guardDocuments(request);}catch(error){return Response.json({error:error instanceof Error?error.message:'접근할 수 없습니다.'},{status:error instanceof DocumentError?error.status:403,headers:{'Cache-Control':'no-store'}});}
 try{return await createDocumentApi(new DocumentStore(getDocumentPool()),new DocumentQueue(getDocumentPool()))(request,ids);}
 catch{return Response.json({error:'PDF 요청을 처리하지 못했습니다. DB 설정을 확인하세요.'},{status:503,headers:{'Cache-Control':'no-store'}});}
}
