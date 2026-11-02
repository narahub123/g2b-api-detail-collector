'use client';

import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import type {DocumentFile} from '@/lib/documents/history-store';
import {requestManualExtraction,manualExtractionMessage,type ManualExtractionResult} from '@/lib/documents/manual-request';
import {FormAccordion} from './FormAccordion';

type Result={document:DocumentFile;value?:ManualExtractionResult;error?:string};

/** 이력 보기에는 기존 카드를 유지하고 파일별 보기에서만 페이지 단위 선택을 제공합니다. */
export function DocumentExtractionSelection({documents,scopeKey,children}:{documents?:DocumentFile[];scopeKey:string;children:ReactNode[]|undefined}){
 if(!documents)return <div className="extraction-list">{children}</div>;
 return <Selection key={scopeKey} documents={documents}>{children}</Selection>;
}

/** 화면에 표시된 파일만 순차 접수하며 결과를 유지한 채 서버 목록을 갱신합니다. */
function Selection({documents,children}:{documents:DocumentFile[];children:ReactNode[]|undefined}){
 const router=useRouter();
 const [selected,setSelected]=useState<string[]>([]),[results,setResults]=useState<Result[]>([]),[posting,setPosting]=useState(false),[total,setTotal]=useState(0),[processed,setProcessed]=useState(0);
 const pending=useRef<AbortController|null>(null),allCheckbox=useRef<HTMLInputElement|null>(null);
 const succeeded=new Set(results.filter(result=>result.value).map(result=>result.document.document_id));
 const available=[...new Map(documents.filter(doc=>doc.requestState?.canRequest&&!succeeded.has(doc.document_id)).map(doc=>[doc.document_id,doc])).values()].slice(0,20);
 const chosen=available.filter(doc=>selected.includes(doc.document_id));
 const all=available.length>0&&chosen.length===available.length;
 useEffect(()=>{if(allCheckbox.current)allCheckbox.current.indeterminate=chosen.length>0&&!all;},[chosen.length,all]);
 useEffect(()=>()=>{pending.current?.abort();},[]);
 /** 문서별 실패를 독립적으로 보존하고 이미 접수된 요청은 자동 재전송하지 않습니다. */
 async function start(){
  if(pending.current||!chosen.length)return;
  const abort=new AbortController();pending.current=abort;setPosting(true);setTotal(chosen.length);setProcessed(0);
  // 재요청한 항목만 교체해 이전 성공 링크와 중복 접수 방지를 유지합니다.
  const retryIds=new Set(chosen.map(doc=>doc.document_id));
  const retained=results.filter(item=>!retryIds.has(item.document.document_id));setResults(retained);
  const completed:Result[]=[];
  // 화면을 떠나면 아직 전송하지 않은 요청은 중단하며 서버에 접수된 요청은 유지합니다.
  for(const document of chosen){
   if(abort.signal.aborted)break;
   try{const value=await requestManualExtraction(document.notice_key,document.document_id,abort.signal);completed.push({document,value});}
   catch(reason){if(abort.signal.aborted)break;completed.push({document,error:reason instanceof Error?reason.message:'추출 요청 실패'});}
   if(!abort.signal.aborted){setResults([...retained,...completed]);setProcessed(completed.length);}
  }
  if(!abort.signal.aborted){
   setSelected(completed.filter(item=>item.error).map(item=>item.document.document_id));setPosting(false);
   router.refresh();
  }
  if(pending.current===abort)pending.current=null;
 }
 const fresh=results.filter(item=>item.value&&!item.value.reused).length,reused=results.filter(item=>item.value?.reused).length,failed=results.filter(item=>item.error).length;
 return <>
  <FormAccordion title="선택 문서 추출" className="extraction-batch-accordion">
  <section className="extraction-batch-actions" aria-label="문서 다중 추출">
   <label><input ref={allCheckbox} type="checkbox" aria-label="현재 페이지 전체 선택" disabled={posting||!available.length} checked={all} onChange={()=>setSelected(all?[]:available.map(doc=>doc.document_id))}/> 현재 페이지 전체 선택</label>
   <span>선택 {chosen.length}개 / 최대 20개</span>
   <button className="extraction-button" disabled={posting||!chosen.length} onClick={()=>void start()}>선택 문서 추출 요청</button>
   <p className="extraction-meta">현재 페이지의 직접 첨부 PDF를 선택해 요청합니다. 화면을 떠나면 남은 접수는 중단되고 이미 접수된 요청은 유지됩니다.</p>
   {posting&&<p role="status">접수 진행 {processed} / {total}</p>}
   {!posting&&results.length>0&&<p role="status">신규 접수 {fresh}건 · 기존 요청 {reused}건 · 실패 {failed}건</p>}
   {results.length>0&&<ul>{results.map(item=><li key={item.document.document_id}>{item.value?<><a href={`/admin/document-extractions/${encodeURIComponent(item.value.id)}`}>{item.document.filename} 실행 확인</a> · {item.value.reused?'기존 요청 재사용':'신규 접수'} · {manualExtractionMessage(item.value)}</>:<span role="alert">{item.document.filename} · {item.error}</span>}</li>)}</ul>}
  </section>
  </FormAccordion>
  <div className="extraction-list">{documents.map((doc,index)=><article key={doc.document_id} className="extraction-card extraction-selectable-card">
   <h2 className="extraction-selectable-title"><input type="checkbox" aria-label={`${doc.filename} 선택`} disabled={posting||!doc.requestState?.canRequest||succeeded.has(doc.document_id)} checked={chosen.some(item=>item.document_id===doc.document_id)} onChange={event=>setSelected(current=>event.target.checked?[...current,doc.document_id]:current.filter(id=>id!==doc.document_id))}/><a href={doc.latest?`/admin/document-extractions/${doc.latest.id}`:`/admin/bids/${encodeURIComponent(doc.notice_key)}`}>{doc.filename}</a></h2>
   {!doc.requestState?.canRequest&&<p className="extraction-meta">{doc.requestState?.reason??'추출 가능 상태를 확인하지 못했습니다.'}{doc.requestState?.active&&<>{' '}<a href={`/admin/document-extractions/${encodeURIComponent(doc.requestState.active.id)}`}>진행 중인 실행 확인</a></>}</p>}
   {children?.[index]}
  </article>)}</div>
 </>;
}
