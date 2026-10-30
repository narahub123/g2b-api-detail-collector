import {notFound} from 'next/navigation';
import {DocumentHistoryStore,runIdPattern} from '@/lib/documents/history-store';
import {getDocumentPool} from '@/lib/documents/pool';
import {guardDocumentPage} from '@/lib/documents/page-access';
import {DocumentExtractionDetail} from '@/components/DocumentExtractionDetail';
import '../../../admin-history.css';

export const runtime='nodejs';
export const dynamic='force-dynamic';

/** 단일 실행의 기술 진단과 재시도 연결을 최초 렌더링에 제공합니다. */
export default async function ExtractionDetailPage({params}:{params:Promise<{runId:string}>}){
 await guardDocumentPage();
 const {runId}=await params;if(!runIdPattern.test(runId))notFound();
 let detail;
 try{detail=await new DocumentHistoryStore(getDocumentPool()).detail(runId);}
 catch{return <main className="site-shell"><a className="back-link" href="/admin/document-extractions">← 첨부파일 추출 이력</a><p role="alert" className="extraction-error">추출 이력을 조회하지 못했습니다. DB 설정과 마이그레이션 적용 여부를 확인하세요.</p></main>;}
 if(!detail)notFound();
 return <main className="site-shell" style={{paddingBottom:70}}><a className="back-link" href="/admin/document-extractions">← 첨부파일 추출 이력</a><DocumentExtractionDetail initial={detail}/></main>;
}
