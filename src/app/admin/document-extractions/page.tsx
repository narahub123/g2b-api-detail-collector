import {DocumentHistoryStore,parseHistoryFilters} from '@/lib/documents/history-store';
import type {HistoryFilters,HistoryList} from '@/lib/documents/history-store';
import {getDocumentPool} from '@/lib/documents/pool';
import {guardDocumentPage} from '@/lib/documents/page-access';
import {DocumentError} from '@/lib/documents/contract';
import {runStatuses} from '@/lib/documents/model';
import {documentDuration,documentSource,documentTime} from '@/lib/documents/display';
import '../../admin-history.css';
import '../../notice-list-controls.css';
import {Pagination} from '@/components/Pagination';
import {DocumentExtractionOverview} from '@/components/DocumentExtractionOverview';
import {DocumentOverviewStore} from '@/lib/documents/overview-store';

export const runtime='nodejs';
export const dynamic='force-dynamic';

/** 문서 등록 없이 전체 현황과 검색 조건에 따른 추출 시도 이력을 함께 보여줍니다. */
export default async function ExtractionHistoryPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 await guardDocumentPage();
 // 현황 조회가 실패해도 이력 검색은 유지하며, 서로 독립된 조회를 동시에 시작합니다.
 const overviewPromise=Promise.resolve().then(()=>new DocumentOverviewStore(getDocumentPool()).overview()).then(
  data=>({data,error:''}),()=>({data:null,error:'문서 추출 현황을 조회하지 못했습니다. 잠시 후 자동으로 다시 확인합니다.'}),
 );
 const params=new URLSearchParams();
 for(const [key,value] of Object.entries(await searchParams))if(typeof value==='string')params.set(key,value);
 let filters:HistoryFilters|undefined,history:HistoryList|undefined,types:string[]=[],error='';
 try{
  filters=parseHistoryFilters(params);const store=new DocumentHistoryStore(getDocumentPool());
  [history,types]=await Promise.all([store.list(filters),store.types()]);
 }catch(reason){error=reason instanceof DocumentError?reason.message:'추출 이력을 조회하지 못했습니다. DB 설정과 마이그레이션 적용 여부를 확인하세요.';}
 const overview=await overviewPromise;
 /** 페이지를 바꾸어도 입력한 검색 조건을 유지합니다. */
 const pageUrl=(page:number)=>{const next=new URLSearchParams(params);next.set('page',String(page));return `/admin/document-extractions?${next}`;};
 return <main className="site-shell" style={{paddingBottom:70}}>
  <a className="back-link" href="/admin">← 관리 화면으로 돌아가기</a>
  <header className="extraction-header"><span className="eyebrow">DOCUMENT EXTRACTIONS</span><h1>첨부파일 추출 이력</h1><p>문서별 추출 시도와 오류 원인을 확인합니다. 시각과 접수일은 한국 시간 기준입니다.</p></header>
  <DocumentExtractionOverview initial={overview.data} initialError={overview.error}/>
  <form method="get" className="extraction-filters">
   <label>처리 상태<select name="status" defaultValue={params.get('status')||''}><option value="">전체</option>{Object.entries(runStatuses).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label>문서 형식<select name="type" defaultValue={params.get('type')||''}><option value="">전체</option>{Array.from(new Set([...types,...(params.get('type')?[params.get('type')!]:[])])).map(type=><option key={type} value={type}>{type.toUpperCase()}</option>)}</select></label>
   <label>파일명<input name="filename" defaultValue={params.get('filename')||''} maxLength={200}/></label>
   <label>공고 키<input name="key" defaultValue={params.get('key')||''} maxLength={200}/></label>
   <label>접수 시작일<input type="date" name="from" defaultValue={params.get('from')||''}/></label>
   <label>접수 종료일<input type="date" name="to" defaultValue={params.get('to')||''}/></label>
   <div className="extraction-filter-actions">
    <a className="extraction-filter-reset" href="/admin/document-extractions">초기화</a>
    <button type="submit">필터 적용</button>
   </div>
  </form>
  {error&&<p role="alert" className="extraction-error">{error}</p>}
  {history&&<><div className="extraction-list">{history.items.map(run=><article key={run.id} className="extraction-card">
   <h2><a href={`/admin/document-extractions/${run.id}`}>{run.filename}</a></h2>
   <span className="extraction-status" data-status={run.status}>{runStatuses[run.status]}</span>
   <p className="extraction-meta">{run.document_type?.toUpperCase()||'형식 기록 없음'} · {documentSource(run.source)} · {run.attempt_number}차 시도 · 소요 {documentDuration(run.elapsed_ms)}</p>
   <p>공고 <a href={`/admin/bids/${encodeURIComponent(run.notice_key)}`}>{run.notice_key}</a><br/>접수 {documentTime(run.requested_at)}</p>
   {run.error&&<p className="extraction-diagnostic">{run.error_code&&<strong>{run.error_code} · </strong>}{run.error}</p>}
  </article>)}</div>
   {!history.items.length&&<p className="empty-state">저장된 추출 이력이 없습니다.</p>}
   <Pagination page={filters!.page} totalPages={history.totalPages} href={pageUrl} label="추출 이력 페이지"/>
  </>}
 </main>;
}
