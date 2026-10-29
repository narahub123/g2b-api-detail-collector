import {DocumentError} from './contract';
/** 로컬 관리자 화면과 API를 같은 활성화 설정으로 제어합니다. */
export function documentsEnabled(){return process.env.PDF_EXTRACTION_ENABLED==='true'&&process.env.NODE_ENV!=='production';}
/** 로컬 개발·호스트·출처 제한을 새 운영 API에서도 유지합니다. */
export function guardDocuments(request:Request){
 if(!documentsEnabled())throw new DocumentError('로컬 PDF 추출이 비활성화되어 있습니다.',404);
 const url=new URL(request.url);
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new DocumentError('로컬에서만 사용할 수 있습니다.',403);
 const origin=request.headers.get('origin');
 if((origin&&origin!==url.origin)||request.headers.get('sec-fetch-site')==='cross-site')throw new DocumentError('다른 출처의 요청은 허용하지 않습니다.',403);
}
