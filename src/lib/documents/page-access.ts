import {headers} from 'next/headers';
import {notFound} from 'next/navigation';
import {guardDocuments} from './access';

/** 서버 렌더링에서도 요청 호스트와 출처를 확인한 뒤 DB 접근을 허용합니다. */
export async function guardDocumentPage(){
 const incoming=await headers();
 try{
  const host=incoming.get('host');if(!host)notFound();
  guardDocuments(new Request(`http://${host}/admin/document-extractions`,{headers:incoming}));
 }catch{notFound();}
}
