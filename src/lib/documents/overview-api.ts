import {guardDocuments} from './access';
import {DocumentError} from './contract';
import {getDocumentPool} from './pool';
import {DocumentOverviewStore} from './overview-store';

/** 현황 조회에도 기존 로컬 관리자 접근 제한과 비캐시 정책을 적용합니다. */
export function createOverviewApi(store:Pick<DocumentOverviewStore,'overview'>){
 return async(request:Request)=>{
  try{
   guardDocuments(request);
   if(request.method!=='GET')return Response.json({error:'조회만 지원합니다.'},{status:405,headers:{'Cache-Control':'no-store',Allow:'GET'}});
   return Response.json(await store.overview(),{headers:{'Cache-Control':'no-store'}});
  }catch(error){return overviewError(error);}
 };
}

/** 연결 정보가 오류 응답에 섞이지 않도록 공개 안내만 반환합니다. */
function overviewError(error:unknown){
 return Response.json({error:error instanceof DocumentError?error.message:'문서 추출 현황을 조회하지 못했습니다. DB 설정을 확인하세요.'},
  {status:error instanceof DocumentError?error.status:503,headers:{'Cache-Control':'no-store'}});
}

/** 기능이 비활성화되어 있으면 DB 풀을 생성하지 않습니다. */
export async function overviewApi(request:Request){
 try{guardDocuments(request);return await createOverviewApi(new DocumentOverviewStore(getDocumentPool()))(request);}
 catch(error){return overviewError(error);}
}
