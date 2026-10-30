import {DocumentHistoryStore,parseHistoryFilters} from '@/lib/documents/history-store';
import type {DocumentFileList,HistoryFilters,HistoryList} from '@/lib/documents/history-store';
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

/** 문서 등록 없이 누적 현황과 파일별 최신 상태 또는 추출 시도 이력을 보여줍니다. */
export default async function ExtractionHistoryPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 await guardDocumentPage();
 // 현황 조회가 실패해도 이력 검색은 유지하며, 서로 독립된 조회를 동시에 시작합니다.
 const overviewPromise=Promise.resolve().then(()=>new DocumentOverviewStore(getDocumentPool()).overview()).then(
  data=>({data,error:''}),()=>({data:null,error:'문서 추출 현황을 조회하지 못했습니다. 잠시 후 자동으로 다시 확인합니다.'}),
 );
 const params=new URLSearchParams();
 for(const [key,value] of Object.entries(await searchParams))if(typeof value==='string')params.set(key,value);
 let filters:HistoryFilters|undefined,history:HistoryList|undefined,documents:DocumentFileList|undefined,types:string[]=[],error='';
 try{
  filters=parseHistoryFilters(params);const store=new DocumentHistoryStore(getDocumentPool());
  if(filters.view==='documents')[documents,types]=await Promise.all([store.listDocuments(filters),store.types()]);
  else [history,types]=await Promise.all([store.list(filters),store.types()]);
 }catch(reason){error=reason instanceof DocumentError?reason.message:'추출 이력을 조회하지 못했습니다. DB 설정과 마이그레이션 적용 여부를 확인하세요.';}
 const overview=await overviewPromise;
 const documentView=filters?.view==='documents',listing=documents??history;
 const records=documents?documents.items.map(item=>({...item,run:item.latest})):history?.items.map(run=>({document_id:run.document_id,notice_key:run.notice_key,filename:run.filename,document_type:run.document_type,created_at:run.requested_at,run}));
 const availableTypes=Array.from(new Set([...types,...(overview.data?.byType.flatMap(item=>item.type===null?[]:[item.type])??[]),...(params.get('type')&&params.get('type')!=='__unknown__'?[params.get('type')!]:[])]));
 /** 페이지를 바꾸어도 입력한 검색 조건을 유지합니다. */
 const pageUrl=(page:number)=>{const next=new URLSearchParams(params);next.set('page',String(page));return `/admin/document-extractions?${next}`;};
 return <main className="site-shell" style={{paddingBottom:70}}>
  <a className="back-link" href="/admin">← 관리 화면으로 돌아가기</a>
  <header className="extraction-header"><span className="eyebrow">DOCUMENT EXTRACTIONS</span><h1>첨부파일 추출 이력</h1><p>문서별 추출 시도와 오류 원인을 확인합니다. 시각과 접수일은 한국 시간 기준입니다.</p></header>
  <DocumentExtractionOverview initial={overview.data} initialError={overview.error} selection={documentView?{type:filters!.type,status:filters!.status}:undefined}/>
  <section id="extraction-results" aria-labelledby="extraction-results-heading">
  <h2 id="extraction-results-heading" className="extraction-results-heading">{documentView?'파일별 최신 상태':'추출 시도 이력'}{listing&&` · ${listing.totalCount.toLocaleString('ko-KR')}${documentView?'개':'건'}`}</h2>
  {documentView&&<p className="extraction-meta">파일마다 최신 상태 한 건을 표시합니다. <a href="/admin/document-extractions#extraction-results">전체 추출 시도 이력 보기</a></p>}
  <form method="get" className="extraction-filters">
   {documentView&&<input type="hidden" name="view" value="documents"/>}
   <label>처리 상태<select name="status" defaultValue={params.get('status')||''}><option value="">전체</option>{documentView&&<option value="unrequested">미요청</option>}{Object.entries(runStatuses).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label>문서 형식<select name="type" defaultValue={params.get('type')||''}><option value="">전체</option>{documentView&&<option value="__unknown__">형식 기록 없음</option>}{availableTypes.map(type=><option key={type} value={type}>{type.toUpperCase()}</option>)}</select></label>
   <label>파일명<input name="filename" defaultValue={params.get('filename')||''} maxLength={200}/></label>
   <label>공고 키<input name="key" defaultValue={params.get('key')||''} maxLength={200}/></label>
   <label>{documentView?'등록·접수 시작일':'접수 시작일'}<input type="date" name="from" defaultValue={params.get('from')||''}/></label>
   <label>{documentView?'등록·접수 종료일':'접수 종료일'}<input type="date" name="to" defaultValue={params.get('to')||''}/></label>
   <div className="extraction-filter-actions">
    <a className="extraction-filter-reset" href="/admin/document-extractions">초기화</a>
    <button type="submit">필터 적용</button>
   </div>
  </form>
  {error&&<p role="alert" className="extraction-error">{error}</p>}
  {listing&&<><div className="extraction-list">{records?.map(item=><article key={documentView?item.document_id:item.run!.id} className="extraction-card">
   <h2><a href={item.run?`/admin/document-extractions/${item.run.id}`:`/admin/bids/${encodeURIComponent(item.notice_key)}`}>{item.filename}</a></h2>
   <span className="extraction-status" data-status={item.run?.status??'unrequested'}>{item.run?runStatuses[item.run.status]:'미요청'}</span>
   <p className="extraction-meta">{item.document_type?.toUpperCase()||'형식 기록 없음'} · {item.run?<>{documentSource(item.run.source)} · {item.run.attempt_number}차 시도 · 소요 {documentDuration(item.run.elapsed_ms)}</>:'추출 요청 이력이 없습니다.'}</p>
   <p>공고 <a href={`/admin/bids/${encodeURIComponent(item.notice_key)}`}>{item.notice_key}</a><br/>{item.run?'접수':'등록'} {documentTime(item.run?.requested_at??item.created_at)}</p>
   {item.run?.error&&<p className="extraction-diagnostic">{item.run.error_code&&<strong>{item.run.error_code} · </strong>}{item.run.error}</p>}
  </article>)}</div>
   {!listing.items.length&&<p className="empty-state">{documentView?'조건에 맞는 문서가 없습니다.':'저장된 추출 이력이 없습니다.'}</p>}
   <Pagination page={filters!.page} totalPages={listing.totalPages} href={pageUrl} label={documentView?'최신 문서 목록 페이지':'추출 이력 페이지'}/>
  </>}
  </section>
 </main>;
}
