'use client';

import {useEffect,useRef,useState} from 'react';
import type {DocumentRequestState} from '@/lib/documents/request-state';
import {manualExtractionMessage,requestManualExtraction,type ManualExtractionResult} from '@/lib/documents/manual-request';

/** 요청 상태와 관계없이 버튼 위치를 유지하며 안내는 필요에 따라 상위 본문 영역에서 표시합니다. */
export function ManualExtractionAction({noticeKey,documentId,state,label='재추출',onAccepted,showFeedback=true,onError}:{noticeKey:string;documentId:string;state?:DocumentRequestState;label?:string;onAccepted?:(result:ManualExtractionResult)=>void;showFeedback?:boolean;onError?:(message:string)=>void}){
 const [posting,setPosting]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<ManualExtractionResult|null>(null);
 const pending=useRef<AbortController|null>(null);
 useEffect(()=>()=>{pending.current?.abort();},[]);
 /** 연속 클릭을 동기적으로 차단하고 화면을 떠난 요청 결과는 반영하지 않습니다. */
 async function start(){
  if(pending.current||!state?.canRequest||result)return;
  const abort=new AbortController();pending.current=abort;setPosting(true);setError('');onError?.('');
  try{const value=await requestManualExtraction(noticeKey,documentId,abort.signal);if(!abort.signal.aborted){setResult(value);onAccepted?.(value);}}
  catch(reason){if(!abort.signal.aborted){const message=reason instanceof Error?reason.message:'추출 요청 실패';setError(message);onError?.(message);}}
  finally{if(!abort.signal.aborted)setPosting(false);if(pending.current===abort)pending.current=null;}
 }
 return <section aria-label="수동 추출" className="extraction-request-actions">
  <button className="extraction-button" disabled={posting||!state?.canRequest||!!result} onClick={()=>void start()}>{posting?'접수 중…':label}</button>
  {showFeedback&&<>{result?<p role="status">{manualExtractionMessage(result)}{' '}<a href={`/admin/document-extractions/${encodeURIComponent(result.id)}`}>접수한 실행 확인</a></p>:
   !state?.canRequest&&<p>{state?.reason??'추출 가능 상태를 확인하지 못했습니다. 화면을 새로 조회하세요.'}{state?.active&&<>{' '}<a href={`/admin/document-extractions/${encodeURIComponent(state.active.id)}`}>진행 중인 실행 확인</a></>}</p>}
  {error&&<p role="alert" className="extraction-error">{error}</p>}</>}
 </section>;
}
