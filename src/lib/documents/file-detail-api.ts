import {guardDocuments} from './access';
import {DocumentError} from './contract';
import {DocumentHistoryStore,runIdPattern} from './history-store';
import {getDocumentPool} from './pool';

/** 로컬 접근과 파일 ID를 검증한 뒤 본문을 포함하지 않는 파일 요약을 반환합니다. */
export function createFileDetailApi(store:Pick<DocumentHistoryStore,'file'>){
 return async(request:Request,id:string)=>{
  const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  try{
   guardDocuments(request);
   if(request.method!=='GET')return reply({error:'조회만 지원합니다.'},405);
   if(!runIdPattern.test(id))return reply({error:'파일을 찾을 수 없습니다.'},404);
   const file=await store.file(id);return file?reply(file):reply({error:'파일을 찾을 수 없습니다.'},404);
  }catch(error){return reply({error:error instanceof DocumentError?error.message:'파일 정보를 조회하지 못했습니다.'},error instanceof DocumentError?error.status:503);}
 };
}
/** 비활성 기능에서는 DB 연결을 만들지 않고 로컬 접근 제한을 유지합니다. */
export async function fileDetailApi(request:Request,id:string){
 try{guardDocuments(request);return await createFileDetailApi(new DocumentHistoryStore(getDocumentPool()))(request,id);}
 catch(error){return Response.json({error:error instanceof DocumentError?error.message:'파일 정보를 조회하지 못했습니다.'},{status:error instanceof DocumentError?error.status:503,headers:{'Cache-Control':'no-store'}});}
}
