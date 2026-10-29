"use client";

import {useCallback,useEffect,useRef,useState} from 'react';
import {FormAccordion} from './FormAccordion';
import {isActive,runStatuses} from '@/lib/documents/model';
import type {DocumentList,DocumentSummary,RunMetadata} from '@/lib/documents/model';

/** 서버가 저장한 응답만 읽고 통신 실패를 표시 가능한 오류로 통일합니다. */
async function readJson<T>(url:string,signal?:AbortSignal,init?:RequestInit):Promise<T>{
 const response=await fetch(url,{cache:'no-store',signal,...init});const value=await response.json();
 if(!response.ok)throw new Error(typeof value.error==='string'?value.error:'PDF 정보를 조회하지 못했습니다.');return value;
}
/** 공고의 파일별 요약만 조회하고 활성 요청이 있을 때만 목록을 갱신합니다. */
export function DocumentPanel({noticeKey}:{noticeKey:string}){
 const [list,setList]=useState<DocumentList|null>(null),[error,setError]=useState('');
 const query=`key=${encodeURIComponent(noticeKey)}`;
 const refresh=useCallback(async(signal?:AbortSignal)=>{
  try{const result=await readJson<DocumentList>(`/api/admin/documents?${query}`,signal);if(!signal?.aborted){setList(result);setError('');}}
  catch(reason){if(!signal?.aborted)setError(reason instanceof Error?reason.message:'파일 목록 조회 실패');}
 },[query]);
 useEffect(()=>{const abort=new AbortController();void refresh(abort.signal);return()=>abort.abort();},[refresh]);
 const active=list?.documents.some(doc=>isActive(doc.active))??false;
 useEffect(()=>{
  if(!active)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
  /** 닫힌 파일은 본문을 읽지 않고 공고 상태 요약만 10초마다 갱신합니다. */
  async function poll(){await refresh(abort.signal);if(!abort.signal.aborted)timer=setTimeout(poll,10000);}
  timer=setTimeout(poll,10000);return()=>{abort.abort();clearTimeout(timer);};
 },[active,refresh]);
 const current=list?.documents.filter(doc=>doc.is_current)??[],archived=list?.documents.filter(doc=>!doc.is_current)??[];
 return <section className="detail-section" aria-label="PDF 텍스트 추출">
  <h2>PDF 텍스트 추출</h2>
  <p>파일을 펼쳐 저장된 본문과 이력을 확인하거나 추출을 요청할 수 있습니다.</p>
  {error&&<p role="alert">{error} <button onClick={()=>void refresh()}>목록 다시 조회</button></p>}
  {!list&&!error&&<p>PDF 파일 목록을 확인하고 있습니다.</p>}
  {list&&!current.length&&<p>직접 첨부된 PDF가 없습니다. 다른 파일 형식은 처리하지 않습니다.</p>}
  {current.map((doc,index)=><DocumentFile key={doc.id} document={doc} index={index+1} noticeKey={noticeKey} refresh={refresh}/>)}
  {!!list?.unsupported.length&&<ul>{list.unsupported.map((file,index)=><li key={index}>{file.name} · {file.reason}</li>)}</ul>}
  {!!archived.length&&<><h3>이전 첨부 이력</h3><p>현재 첨부 목록에서 사라진 파일입니다. 저장된 결과는 계속 조회할 수 있습니다.</p>
   {archived.map((doc,index)=><DocumentFile key={doc.id} document={doc} index={index+1} noticeKey={noticeKey} refresh={refresh}/>)}</>}
 </section>;
}

/** 파일별 열림·실행 선택·페이지를 독립적으로 유지하고 열린 파일만 상세 조회합니다. */
function DocumentFile({document:doc,index,noticeKey,refresh}:{document:DocumentSummary;index:number;noticeKey:string;refresh:(signal?:AbortSignal)=>Promise<void>}){
 const [open,setOpen]=useState(false),[visited,setVisited]=useState(false);
 const [history,setHistory]=useState<RunMetadata[]>([]),[cursor,setCursor]=useState<string|null>(null);
 const historyGeneration=useRef(0),paginationRequest=useRef<AbortController|null>(null);
 const [selection,setSelection]=useState(''),[run,setRun]=useState<RunMetadata|null>(null),[page,setPage]=useState(1),[text,setText]=useState<string|null>(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[posting,setPosting]=useState(false),[loadingHistory,setLoadingHistory]=useState(false);
 const query=`key=${encodeURIComponent(noticeKey)}`,base=`/api/admin/documents/${doc.id}/extractions`;
 const selectedId=selection||doc.success?.id||doc.latest?.id||'';
 const previousSelection=useRef(selectedId);
 useEffect(()=>{if(previousSelection.current!==selectedId){previousSelection.current=selectedId;setPage(1);setText(null);}},[selectedId]);
 const status=doc.active?.status??doc.latest?.status;
 const pending=isActive(doc.active);
 useEffect(()=>{
  const generation=++historyGeneration.current;
  paginationRequest.current?.abort();setLoadingHistory(false);
  if(!open)return;const abort=new AbortController();
  readJson<{runs:RunMetadata[];nextCursor:string|null}>(`${base}?${query}&limit=20`,abort.signal)
   .then(result=>{if(!abort.signal.aborted&&historyGeneration.current===generation){setHistory(result.runs);setCursor(result.nextCursor);}})
   .catch(reason=>{if(!abort.signal.aborted)setError(reason.message);});
  return()=>{abort.abort();paginationRequest.current?.abort();historyGeneration.current++;};
 },[open,base,query,doc.latest?.id]);
 useEffect(()=>{
  if(!open||!selectedId)return;const abort=new AbortController();setRun(null);
  readJson<RunMetadata>(`${base}/${selectedId}?${query}`,abort.signal).then(value=>{if(!abort.signal.aborted)setRun(value);})
   .catch(reason=>{if(!abort.signal.aborted)setError(reason.message);});
  return()=>abort.abort();
 },[open,selectedId,base,query]);
 useEffect(()=>{
  if(!open||!selectedId||run?.id!==selectedId||!run?.page_count)return;
  const abort=new AbortController();setText(null);
  readJson<{text:string}>(`${base}/${selectedId}/pages/${page}?${query}`,abort.signal).then(value=>{if(!abort.signal.aborted){setText(value.text);setError('');}})
   .catch(reason=>{if(!abort.signal.aborted)setError(reason.message);});
  return()=>abort.abort();
 },[open,selectedId,page,run?.page_count,base,query]);
 useEffect(()=>{
  if(!open||!doc.active)return;const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
  /** 열린 파일의 현재 실행만 폴링하며 완료 시 목록을 다시 읽어 성공 본문을 선택합니다. */
  async function poll(){
   try{
    const value=await readJson<RunMetadata>(`${base}/${doc.active!.id}?${query}`,abort.signal);
    if(abort.signal.aborted)return;
    if(value.id===selectedId)setRun(value);
    setHistory(current=>[value,...current.filter(item=>item.id!==value.id)]);
    if(!isActive(value)){await refresh(abort.signal);return;}
   }catch(reason){if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'처리 상태 조회 실패');}
   if(!abort.signal.aborted)timer=setTimeout(poll,2000);
  }
  timer=setTimeout(poll,2000);return()=>{abort.abort();clearTimeout(timer);};
 },[open,doc.active?.id,selectedId,base,query,refresh]);
 /** 공통 대기열 접수 뒤에는 항상 DB 요약을 다시 읽으며 이전 성공 본문을 유지합니다. */
 async function start(){
  setPosting(true);setError('');setNotice('');
  try{
   const result=await readJson<{id:string;awake:boolean}>(`${base}?${query}`,undefined,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:noticeKey})});
   setSelection('');setNotice(result.awake?'추출 요청을 접수했습니다. 작업기가 순서대로 처리합니다.':'작업기에 연결하지 못했지만 추출 요청은 저장했습니다. 작업기 시작 또는 다음 깨우기에서 처리합니다.');
   await refresh();
  }catch(reason){setError(reason instanceof Error?reason.message:'추출 요청 실패');}finally{setPosting(false);}
 }
 /** 최근 이력과 겹치지 않는 과거 이력을 이어 붙입니다. */
 async function more(){
  if(!cursor)return;setLoadingHistory(true);
  const generation=historyGeneration.current,abort=new AbortController();paginationRequest.current?.abort();paginationRequest.current=abort;
  try{const result=await readJson<{runs:RunMetadata[];nextCursor:string|null}>(`${base}?${query}&limit=20&cursor=${encodeURIComponent(cursor)}`,abort.signal);
   if(abort.signal.aborted||historyGeneration.current!==generation)return;
   setHistory(current=>[...current,...result.runs.filter(item=>!current.some(existing=>existing.id===item.id))]);setCursor(result.nextCursor);
  }catch(reason){if(!abort.signal.aborted&&historyGeneration.current===generation)setError(reason instanceof Error?reason.message:'이력 조회 실패');}
  finally{if(historyGeneration.current===generation)setLoadingHistory(false);}
 }
 const latestIssue=doc.latest&&['failed','interrupted','no_text','unsupported'].includes(doc.latest.status)?doc.latest:null;
 const readySince=doc.active?.next_attempt_at||doc.active?.requested_at;
 const overdue=doc.active?.status==='queued'&&readySince&&Date.now()-Date.parse(readySince)>30*60000;
 return <FormAccordion title={`${index}. ${doc.filename} · 첨부 ${doc.seq} · ${status?runStatuses[status]:'미처리'}`} onOpenChange={value=>{setOpen(value);if(value)setVisited(true);}}>
  {visited&&<div aria-label={`${doc.filename} 첨부 ${doc.seq}`}>
   {doc.is_current&&<p><a href={doc.attachment_url} download>원본 다운로드</a>{' '}
    <button disabled={posting||pending} onClick={()=>void start()}>{pending?'요청 접수됨':doc.latest?.status==='completed'?'재추출':doc.latest?'다시 추출':'추출 요청'}</button></p>}
   {!doc.is_current&&<p>이전 첨부는 재추출할 수 없습니다.</p>}
   {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
   {pending&&<p role="status">{doc.active?.status==='processing'?'PDF를 처리하고 있습니다.':'대기 요청이 저장되어 있습니다. 작업기 실행을 기다립니다.'}
    {doc.active?.next_attempt_at&&` 재시도 예정: ${new Date(doc.active.next_attempt_at).toLocaleString('ko-KR')}`}</p>}
   {overdue&&<p role="alert">실행 가능한 요청이 30분 이상 대기 중입니다. 작업기·임대·보완 실행 및 Actions 상태를 확인하세요.</p>}
   {latestIssue&&<p role="alert">최근 시도: {runStatuses[latestIssue.status]}{latestIssue.error?` · ${latestIssue.error}`:''}{doc.success?' · 마지막 성공 본문을 조회할 수 있습니다.':''}</p>}
   {!!history.length&&<p><label>실행 이력{' '}<select aria-label={`실행 이력 첨부 ${doc.seq}`} value={selectedId} onChange={event=>{setSelection(event.target.value);setPage(1);setText(null);}}>
    {selectedId&&!history.some(item=>item.id===selectedId)&&<option value={selectedId}>선택한 저장 기록</option>}
    {history.map(item=><option key={item.id} value={item.id}>{runStatuses[item.status]} · {new Date(item.requested_at).toLocaleString('ko-KR')} · 시도 {item.attempt_number}</option>)}
   </select></label>{' '}{cursor&&<button disabled={loadingHistory} onClick={()=>void more()}>이전 이력 더 보기</button>}</p>}
   {run&&<div><p>{runStatuses[run.status]} · 페이지 {run.page_count??'-'} · 문자 {run.character_count??'-'} · 완료 {run.finished_at?new Date(run.finished_at).toLocaleString('ko-KR'):'-'}</p>
    {run.error&&run.id!==latestIssue?.id&&<p role="alert">{run.error}</p>}
    {!!run.page_count&&<><label>페이지{' '}<select aria-label={`페이지 첨부 ${doc.seq}`} value={page} onChange={event=>setPage(Number(event.target.value))}>
     {Array.from({length:run.page_count},(_,i)=><option key={i+1} value={i+1}>{i+1}쪽</option>)}</select></label>{' '}
     <button disabled={page<=1} onClick={()=>setPage(value=>value-1)}>이전</button>{' '}<button disabled={page>=run.page_count} onClick={()=>setPage(value=>value+1)}>다음</button>
     <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'60vh',overflow:'auto',background:'#f5f7fa',padding:16}}>{text===null?'저장된 본문을 조회하고 있습니다.':text||'이 페이지에서 추출된 텍스트가 없습니다.'}</pre></>}
    {run.status==='no_text'&&<p>텍스트가 없는 PDF입니다. OCR은 실행하지 않습니다.</p>}
    <details><summary>처리 정보</summary><p>추출기: {run.extractor_version??'-'} · 처리 시간: {run.elapsed_ms==null?'-':`${(run.elapsed_ms/1000).toFixed(1)}초`} · 최대 메모리: {run.peak_memory_bytes?`${(Number(run.peak_memory_bytes)/1024/1024).toFixed(0)}MiB`:'-'}</p></details>
   </div>}
   {!selectedId&&<p>저장된 실행 결과가 없습니다.</p>}
  </div>}
 </FormAccordion>;
}
