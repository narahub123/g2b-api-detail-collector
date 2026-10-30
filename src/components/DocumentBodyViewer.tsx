'use client';

import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';

type PageData={pageNumber:number;text:string};
type BodyError={pageNumber:number;message:string};
type ScrollEvent={requestId:number;phase:'align'|'settled'};
type ViewerState={displayed:PageData|null;requestedPage:number|null;error:BodyError|null;started:boolean;scrollEvent:ScrollEvent|null};
type RequestAttempt={id:number;controller:AbortController;pending:boolean;aligned:boolean;userMoved:boolean};
type ViewerProps={noticeKey:string;documentId:string;runId:string;pageCount:number};

/** 실행별 캐시와 요청 수명이 다른 실행으로 이어지지 않도록 경계를 분리합니다. */
export function DocumentBodyViewer(props:ViewerProps){
 const identity=JSON.stringify([props.noticeKey,props.documentId,props.runId]);
 return <BodyViewer key={identity} {...props}/>;
}

/** 표시 중인 본문을 유지하며 요청·캐시·스크롤을 독립적으로 제어합니다. */
function BodyViewer({noticeKey,documentId,runId,pageCount}:ViewerProps){
 const [state,setState]=useState<ViewerState>({displayed:null,requestedPage:null,error:null,started:false,scrollEvent:null});
 const sectionRef=useRef<HTMLElement>(null),textRef=useRef<HTMLPreElement>(null);
 const cache=useRef(new Map<string,PageData>()),sequence=useRef(0),attemptRef=useRef<RequestAttempt|null>(null);
 const headingId=useId(),loading=state.requestedPage!==null;

 useEffect(()=>{
  /** 이용자가 직접 이동했다면 늦은 응답으로 화면 위치를 되돌리지 않습니다. */
  const moved=()=>{const attempt=attemptRef.current;if(attempt?.aligned)attempt.userMoved=true;};
  const keydown=(event:KeyboardEvent)=>{if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' ','Tab'].includes(event.key))moved();};
  window.addEventListener('wheel',moved,{passive:true,capture:true});
  window.addEventListener('touchmove',moved,{passive:true,capture:true});
  window.addEventListener('pointerdown',moved,true);
  window.addEventListener('keydown',keydown,true);
  return()=>{
   window.removeEventListener('wheel',moved,true);window.removeEventListener('touchmove',moved,true);
   window.removeEventListener('pointerdown',moved,true);window.removeEventListener('keydown',keydown,true);
   ++sequence.current;attemptRef.current?.controller.abort();attemptRef.current=null;cache.current.clear();
  };
 },[]);

 useLayoutEffect(()=>{
  const section=sectionRef.current,attempt=attemptRef.current,event=state.scrollEvent;
  if(!section||!attempt||!event||event.requestId!==attempt.id)return;
  const offset=Number.parseFloat(getComputedStyle(section).getPropertyValue('--extraction-scroll-offset'))||16;
  const top=section.getBoundingClientRect().top;
  if(event.phase==='align'||attempt.aligned&&!attempt.userMoved&&Math.abs(top-offset)>2){
   window.scrollTo({top:Math.max(0,window.scrollY+top-offset),behavior:'instant'});
  }
  attempt.aligned=true;
 },[state.scrollEvent]);

 useLayoutEffect(()=>{
  // 대기 중에는 스크롤을 보존하고 새 본문을 표시한 때에만 맨 위로 돌립니다.
  if(state.displayed&&textRef.current)textRef.current.scrollTop=0;
 },[state.displayed]);

 /** 캐시와 서버 응답의 페이지 번호 및 본문을 같은 상태 전이로 반영합니다. */
 function commit(attempt:RequestAttempt,data:PageData,phase:ScrollEvent['phase']){
  if(attemptRef.current!==attempt||attempt.id!==sequence.current||attempt.controller.signal.aborted)return;
  attempt.pending=false;
  setState({displayed:data,requestedPage:null,error:null,started:true,scrollEvent:{requestId:attempt.id,phase}});
 }

 /** 기존 본문을 유지하며 요청하고 유효한 응답만 저장하여 표시합니다. */
 async function readPage(pageNumber:number){
  if(attemptRef.current?.pending||!Number.isInteger(pageNumber)||pageNumber<1||pageNumber>pageCount)return;
  attemptRef.current?.controller.abort();
  const attempt:RequestAttempt={id:++sequence.current,controller:new AbortController(),pending:true,aligned:false,userMoved:false};
  attemptRef.current=attempt;
  const key=JSON.stringify([noticeKey,documentId,runId,pageNumber]),cached=cache.current.get(key);
  if(cached){commit(attempt,cached,'align');return;}
  setState(current=>({...current,requestedPage:pageNumber,error:null,started:true,scrollEvent:{requestId:attempt.id,phase:'align'}}));
  try{
   const response=await fetch(`/api/admin/documents/${documentId}/extractions/${runId}/pages/${pageNumber}?key=${encodeURIComponent(noticeKey)}`,{cache:'no-store',signal:attempt.controller.signal});
   if(!response.ok)throw new Error('저장된 본문을 조회하지 못했습니다.');
   const value=await response.json();
   if(typeof value?.text!=='string'||value.pageNumber!==undefined&&value.pageNumber!==pageNumber)throw new Error('본문 응답 형식을 확인할 수 없습니다.');
   if(attemptRef.current!==attempt||attempt.id!==sequence.current||attempt.controller.signal.aborted)return;
   const data={pageNumber,text:value.text};cache.current.set(key,data);commit(attempt,data,'settled');
  }catch(reason){
   if(attemptRef.current!==attempt||attempt.id!==sequence.current||attempt.controller.signal.aborted)return;
   attempt.pending=false;
   setState(current=>({...current,requestedPage:null,error:{pageNumber,message:reason instanceof Error?reason.message:'본문 조회에 실패했습니다.'}}));
  }
 }

 /** 위아래 이동은 실제 표시 중인 페이지와 동일한 경계 조건을 사용합니다. */
 function navigation(position:'위'|'아래'){
  const page=state.displayed!.pageNumber;
  return <nav className="extraction-nav extraction-page-nav" aria-label={`본문 ${position} 페이지 이동`}>
   <div className="extraction-page-controls">
    <button className="extraction-button" disabled={loading||page<=1} onClick={()=>void readPage(page-1)}>이전 페이지</button>
    <span aria-live="polite">{page} / {pageCount}</span>
    <button className="extraction-button" disabled={loading||page>=pageCount} onClick={()=>void readPage(page+1)}>다음 페이지</button>
   </div>
  </nav>;
 }

 return <section ref={sectionRef} aria-labelledby={headingId} className={`extraction-card extraction-body-section${state.started?' extraction-body-started':''}`} style={{marginTop:24}}>
  <h2 id={headingId}>추출 본문</h2><p>필요한 페이지의 저장된 본문만 조회합니다.</p>
  {!state.displayed?<div className="extraction-body-initial-actions"><button className="extraction-button" disabled={loading} onClick={()=>void readPage(1)}>{loading?'조회 중…':'본문 조회'}</button></div>:navigation('위')}
  {loading&&<p role="status" className="extraction-body-status">{state.requestedPage}페이지를 불러오는 중…</p>}
  {state.error&&<div role="alert" className="extraction-error"><p>{state.error.pageNumber}페이지 · {state.error.message}</p>
   {state.displayed&&<button className="extraction-button" onClick={()=>void readPage(state.error!.pageNumber)}>다시 시도</button>}
  </div>}
  {state.displayed&&<pre ref={textRef} className="extraction-body" aria-busy={loading}>{state.displayed.text||'이 페이지에는 추출된 텍스트가 없습니다.'}</pre>}
  {state.displayed&&navigation('아래')}
 </section>;
}
