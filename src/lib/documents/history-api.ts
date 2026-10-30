import {guardDocuments} from './access';
import {DocumentError} from './contract';
import {DocumentHistoryStore,parseHistoryFilters,runIdPattern} from './history-store';
import {getDocumentPool} from './pool';

/** 전체 이력 조회도 기존 로컬 전용 접근 검사를 먼저 적용합니다. */
export function createHistoryApi(store:DocumentHistoryStore){
 return async(request:Request,id?:string)=>{
  const reply=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
  try{
   guardDocuments(request);
   if(request.method!=='GET')return reply({error:'조회만 지원합니다.'},405);
   if(id!==undefined){
    if(!runIdPattern.test(id))return reply({error:'추출 이력을 찾을 수 없습니다.'},404);
    const detail=await store.detail(id);return detail?reply(detail):reply({error:'추출 이력을 찾을 수 없습니다.'},404);
   }
   return reply(await store.list(parseHistoryFilters(new URL(request.url).searchParams)));
  }catch(error){return reply({error:error instanceof DocumentError?error.message:'추출 이력을 조회하지 못했습니다. DB 설정을 확인하세요.'},error instanceof DocumentError?error.status:503);}
 };
}

/** 기능이 비활성화된 요청에서는 DB 풀을 만들지 않습니다. */
export async function historyApi(request:Request,id?:string){
 try{guardDocuments(request);return await createHistoryApi(new DocumentHistoryStore(getDocumentPool()))(request,id);}
 catch(error){return Response.json({error:error instanceof DocumentError?error.message:'추출 이력을 조회하지 못했습니다. DB 설정을 확인하세요.'},{status:error instanceof DocumentError?error.status:503,headers:{'Cache-Control':'no-store'}});}
}
