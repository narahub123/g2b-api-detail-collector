import {notFound} from 'next/navigation';
import {DocumentHistoryStore,runIdPattern} from '@/lib/documents/history-store';
import {DocumentStore} from '@/lib/documents/store';
import {getDocumentPool} from '@/lib/documents/pool';
import {guardDocumentPage} from '@/lib/documents/page-access';
import {DocumentFileDetail,type FileRunHistory} from '@/components/DocumentFileDetail';
import '../../../../admin-history.css';

export const runtime='nodejs';
export const dynamic='force-dynamic';

/** 파일의 요약과 첫 실행 이력을 제공하며 조회만으로 문서나 대기열을 변경하지 않습니다. */
export default async function DocumentFilePage({params}:{params:Promise<{documentId:string}>}){
 await guardDocumentPage();const {documentId}=await params;if(!runIdPattern.test(documentId))notFound();
 let file;
 try{file=await new DocumentHistoryStore(getDocumentPool()).file(documentId);}
 catch{return <main className="site-shell"><a href="/admin/document-extractions">← 첨부파일 목록</a><p role="alert">파일 정보를 조회하지 못했습니다.</p></main>;}
 if(!file)notFound();
 let history:FileRunHistory={runs:[],nextCursor:null},error='';
 try{history=await new DocumentStore(getDocumentPool()).history(file.notice_key,file.id,20,null);}
 catch{error='추출 이력을 조회하지 못했습니다. 다시 조회하세요.';}
 return <main className="site-shell" style={{paddingBottom:70}}><a className="back-link" href="/admin/document-extractions">← 첨부파일 목록</a><DocumentFileDetail initial={file} initialHistory={history} initialHistoryError={error}/></main>;
}
