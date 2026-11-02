'use client';

import {useEffect,useRef,useState} from 'react';
import type {DocumentRequestState} from '@/lib/documents/request-state';
import {manualExtractionMessage,requestManualExtraction,type ManualExtractionResult} from '@/lib/documents/manual-request';

/** 현재 첨부의 요청 가능 상태를 안내하고 단일 접수 결과를 실행 상세와 연결합니다. */
export function ManualExtractionAction({noticeKey,documentId,state}:{noticeKey:string;documentId:string;state?:DocumentRequestState}){
 const [posting,setPosting]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<ManualExtractionResult|null>(null);
 const pending=useRef<AbortController|null>(null);
 useEffect(()=>()=>{pending.current?.abort();},[]);
 /** 연속 클릭을 동기적으로 차단하고 화면을 떠난 요청 결과는 반영하지 않습니다. */
 async function start(){
  if(pending.current||!state?.canRequest||result)return;
  const abort=new AbortController();pending.current=abort;setPosting(true);setError('');
  try{const value=await requestManualExtraction(noticeKey,documentId,abort.signal);if(!abort.signal.aborted)setResult(value);}
  catch(reason){if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'추출 요청 실패');}
  finally{if(!abort.signal.aborted)setPosting(false);if(pending.current===abort)pending.current=null;}
 }
 return <section aria-label="수동 추출" className="extraction-request-actions">
  {result?<p role="status">{manualExtractionMessage(result)}{' '}<a href={`/admin/document-extractions/${encodeURIComponent(result.id)}`}>접수한 실행 확인</a></p>:
   state?.canRequest?<button className="extraction-button" disabled={posting} onClick={()=>void start()}>{posting?'접수 중…':'재추출'}</button>:
   <p>{state?.reason??'추출 가능 상태를 확인하지 못했습니다. 화면을 새로 조회하세요.'}{state?.active&&<>{' '}<a href={`/admin/document-extractions/${encodeURIComponent(state.active.id)}`}>진행 중인 실행 확인</a></>}</p>}
  {error&&<p role="alert" className="extraction-error">{error}</p>}
 </section>;
}
