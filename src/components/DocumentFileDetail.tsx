'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {Download} from 'lucide-react';
import type {DocumentFileDetail as FileDetail} from '@/lib/documents/history-store';
import type {RunMetadata} from '@/lib/documents/model';
import {runStatuses} from '@/lib/documents/model';
import {documentDuration,documentTime,documentWorkLabel} from '@/lib/documents/display';
import {safeAttachmentLink} from '@/lib/g2b/attachment-links';
import {manualExtractionMessage,type ManualExtractionResult} from '@/lib/documents/manual-request';
import {DocumentBodyViewer} from './DocumentBodyViewer';
import {ManualExtractionAction} from './ManualExtractionAction';

export type FileRunHistory={runs:RunMetadata[];nextCursor:string|null};
type Props={initial:FileDetail;initialHistory:FileRunHistory;initialHistoryError?:string};

/** 파일을 전환하면 본문 캐시와 이력 요청도 함께 초기화합니다. */
export function DocumentFileDetail(props:Props){return <FileDetailView key={props.initial.id} {...props}/>;}

/** 캐시 없이 조회하고 통신 오류를 사용자에게 표시 가능한 안내로 바꿉니다. */
async function readFileJson<T>(url:string,signal:AbortSignal):Promise<T>{
 const response=await fetch(url,{cache:'no-store',signal});
 if(!response.ok)throw new Error('파일 정보와 추출 이력을 조회하지 못했습니다.');
 return response.json();
}

/** 새 첫 페이지가 과거에 펼친 이력을 지우지 않도록 실행 ID로 병합합니다. */
function mergeHistory(fresh:RunMetadata[],previous:RunMetadata[]):RunMetadata[]{
 const ids=new Set(fresh.map(run=>run.id));return [...fresh,...previous.filter(run=>!ids.has(run.id))];
}

/** 파일의 현재 결과와 전체 실행 이력을 분리하고 활성 작업이 있을 때만 갱신합니다. */
function FileDetailView({initial,initialHistory,initialHistoryError=''}:Props){
 const [file,setFile]=useState(initial),[history,setHistory]=useState(initialHistory.runs),[cursor,setCursor]=useState(initialHistory.nextCursor);
 const [watching,setWatching]=useState(!!initial.requestState.active),[loadingMore,setLoadingMore]=useState(false),[error,setError]=useState(initialHistoryError);
 const [receipt,setReceipt]=useState<ManualExtractionResult|null>(null),[requestError,setRequestError]=useState('');
 const refreshRequest=useRef<AbortController|null>(null),moreRequest=useRef<AbortController|null>(null),loadedMore=useRef(false);
 const historyUrl=`/api/admin/documents/${file.id}/extractions?key=${encodeURIComponent(file.notice_key)}&limit=20`;
 const refresh=useCallback(async()=>{
  refreshRequest.current?.abort();const abort=new AbortController();refreshRequest.current=abort;
  try{
   const [next,first]=await Promise.all([
    readFileJson<FileDetail>(`/api/admin/document-extractions/files/${initial.id}`,abort.signal),
    readFileJson<FileRunHistory>(historyUrl,abort.signal),
   ]);
   if(abort.signal.aborted)return null;
   if(next.id!==initial.id||next.notice_key!==initial.notice_key)throw new Error('파일 정보가 일치하지 않습니다.');
   setFile(next);setHistory(previous=>mergeHistory(first.runs,previous));
   if(!loadedMore.current)setCursor(first.nextCursor);
   setError('');setWatching(!!next.requestState.active);return next;
  }catch(reason){if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'파일 갱신 실패');return null;}
 },[initial.id,initial.notice_key,historyUrl]);
 useEffect(()=>()=>{refreshRequest.current?.abort();moreRequest.current?.abort();},[]);
 useEffect(()=>{
  if(!watching)return;
  let disposed=false,timer:ReturnType<typeof setTimeout>;
  /** 완료 응답 뒤에는 재예약하지 않으며 일시적 오류는 다음 회차에서 다시 확인합니다. */
  async function poll(){
   const next=await refresh();
   if(!disposed&&(!next||next.requestState.active))timer=setTimeout(poll,5000);
  }
  timer=setTimeout(poll,5000);return()=>{disposed=true;clearTimeout(timer);refreshRequest.current?.abort();};
 },[watching,refresh]);
 /** 접수 결과는 파일 화면에 남기고 새 요청의 상태와 이력을 즉시 다시 읽습니다. */
 function accepted(result:ManualExtractionResult){setReceipt(result);setWatching(true);void refresh();}
 /** 과거 페이지는 별도 요청으로 읽어 갱신 중인 첫 페이지와 중복 없이 이어 붙입니다. */
 async function more(){
  if(!cursor||moreRequest.current)return;
  const abort=new AbortController();moreRequest.current=abort;setLoadingMore(true);
  try{
   const result=await readFileJson<FileRunHistory>(`${historyUrl}&cursor=${encodeURIComponent(cursor)}`,abort.signal);
   if(abort.signal.aborted)return;
   loadedMore.current=true;setHistory(previous=>mergeHistory(previous,result.runs));setCursor(result.nextCursor);setError('');
  }catch(reason){if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'이력 조회 실패');}
  finally{if(!abort.signal.aborted)setLoadingMore(false);if(moreRequest.current===abort)moreRequest.current=null;}
 }
 const download=file.attachment_url?safeAttachmentLink(file.attachment_url):null;
 return <>
  <header className="extraction-header"><span className="eyebrow">DOCUMENT FILE</span><h1>첨부파일 상세</h1>
   <p className="extraction-file">{file.filename}{download&&<a className="extraction-download-icon" href={download} download aria-label="원본 파일 다운로드"><Download size={18} aria-hidden="true"/></a>}</p>
   <p>공고 <a href={`/admin/bids/${encodeURIComponent(file.notice_key)}`}>{file.notice_key}</a> · {file.document_type?.toUpperCase()||'형식 기록 없음'}</p>
   <span className="extraction-status" data-status={file.latest?.status??'unrequested'}>{file.latest?runStatuses[file.latest.status]:'미요청'}</span>
   {watching&&<p>5초마다 처리 상태와 추출 이력을 확인합니다.</p>}
  </header>
  {error&&<p role="alert" className="extraction-error">{error} <button className="extraction-button" onClick={()=>void refresh()}>다시 조회</button></p>}
  <section className="extraction-card" aria-labelledby="file-history-heading"><h2 id="file-history-heading">추출 이력</h2>
   {!history.length?<p>추출 이력이 없습니다.</p>:<div className="extraction-history-table"><table><thead><tr><th>접수 시각</th><th>작업 구분</th><th>시도</th><th>결과</th><th>소요 시간</th><th>진단</th></tr></thead>
    <tbody>{history.map(run=><tr key={run.id}><td>{documentTime(run.requested_at)}</td><td>{documentWorkLabel(run)}</td><td>{run.attempt_number}차</td><td>{runStatuses[run.status]}</td><td>{documentDuration(run.elapsed_ms)}</td><td><a href={`/admin/document-extractions/${run.id}`}>실행 상세</a></td></tr>)}</tbody></table></div>}
   {cursor&&<button className="extraction-button" disabled={loadingMore} onClick={()=>void more()}>{loadingMore?'이력 조회 중…':'이전 이력 더 보기'}</button>}
  </section>
  <DocumentBodyViewer noticeKey={file.notice_key} documentId={file.id} runId={file.content?.run_id??'none'} pageCount={file.content?.page_count??0}
   currentBodyHref={`/admin/document-extractions/files/${file.id}`} onReplaced={()=>void refresh()}
   source={<>
    {file.content&&<p className="extraction-meta">현재 보관된 성공 본문 · 완료 {documentTime(file.content.finished_at)} · <a href={`/admin/document-extractions/${file.content.run_id}`}>본문 출처 실행 확인</a></p>}
    {!file.requestState.canRequest&&<p className="extraction-meta">{file.requestState.reason}{file.requestState.active&&<>{' '}<a href={`/admin/document-extractions/${file.requestState.active.id}`}>진행 중인 실행 확인</a></>}</p>}
    {receipt&&<p role="status">{manualExtractionMessage(receipt)}{' '}<a href={`/admin/document-extractions/${receipt.id}`}>접수한 실행 확인</a></p>}
    {requestError&&<p role="alert" className="extraction-error">{requestError}</p>}
   </>}
   actions={<ManualExtractionAction key={`${file.latest?.id??'none'}:${file.requestState.active?.id??'none'}`} noticeKey={file.notice_key} documentId={file.id} state={file.requestState} label={file.latest?'재추출':'추출 요청'} onAccepted={accepted} showFeedback={false} onError={setRequestError}/>}
   emptyMessage={<p>저장된 성공 본문이 없습니다.</p>}/>
 </>;
}
