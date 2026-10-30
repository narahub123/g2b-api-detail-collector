'use client';

import {useEffect,useState} from 'react';
import {Download} from 'lucide-react';
import type {HistoryDetail} from '@/lib/documents/history-store';
import {extractionStages} from '@/lib/documents/diagnostics';
import {isActive,runStatuses} from '@/lib/documents/model';
import {documentDuration,documentSource,documentTime} from '@/lib/documents/display';
import {DocumentBodyViewer} from './DocumentBodyViewer';
import {safeAttachmentLink} from '@/lib/g2b/attachment-links';

/** 진행 중에만 갱신하며 본문은 사용자가 요청한 한 페이지만 읽습니다. */
export function DocumentExtractionDetail({initial}:{initial:HistoryDetail}){
 const identity=JSON.stringify([initial.run.notice_key,initial.run.document_id,initial.run.id]);
 return <ExtractionDetail key={identity} initial={initial}/>;
}

/** 원본 다운로드를 제공하고 실행이 바뀌면 진단 폴링과 본문 요청을 새로 시작합니다. */
function ExtractionDetail({initial}:{initial:HistoryDetail}){
 const [detail,setDetail]=useState(initial),[error,setError]=useState('');
 const run=detail.run,active=isActive(run);
 // 저장된 주소도 기존 첨부 링크 검증을 거쳐 다운로드에 사용합니다.
 const downloadUrl=run.attachment_url?safeAttachmentLink(run.attachment_url):null;
 useEffect(()=>{
  if(!active)return;
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>;
  /** 완료 응답을 받으면 다음 폴링을 예약하지 않습니다. */
  async function poll(){
   let next=true;
   try{
    const response=await fetch(`/api/admin/document-extractions/${run.id}`,{cache:'no-store',signal:abort.signal});
    if(!response.ok)throw new Error('추출 상태를 갱신하지 못했습니다.');
    const value=await response.json() as HistoryDetail;if(abort.signal.aborted)return;
    setDetail(value);setError('');next=isActive(value.run);
   }catch(reason){if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'상태 조회 실패');}
   if(next&&!abort.signal.aborted)timer=setTimeout(poll,5000);
  }
  timer=setTimeout(poll,5000);return()=>{abort.abort();clearTimeout(timer);};
 },[run.id,active]);
 return <>
  <header className="extraction-header"><span className="eyebrow">EXTRACTION DIAGNOSTICS</span><h1>첨부파일 추출 진단</h1><p className="extraction-file">{run.filename}{downloadUrl&&<a className="extraction-download-icon" href={downloadUrl} download aria-label="원본 파일 다운로드" title="원본 파일 다운로드"><Download size={18} aria-hidden="true"/></a>}</p><span className="extraction-status" data-status={run.status}>{runStatuses[run.status]}</span>{active&&<p>5초마다 처리 상태를 확인합니다.</p>}</header>
  {error&&<p role="alert" className="extraction-error">{error}</p>}
  <div className="extraction-grid">
   <section className="extraction-card"><h2>실행 정보</h2><dl className="extraction-data">
    <dt>실행 ID</dt><dd>{run.id}</dd><dt>공고</dt><dd><a href={`/admin/bids/${encodeURIComponent(run.notice_key)}`}>{run.notice_key}</a></dd>
    <dt>문서 형식</dt><dd>{run.document_type?.toUpperCase()||'기록 없음'}</dd><dt>요청 출처</dt><dd>{documentSource(run.source)}</dd><dt>시도</dt><dd>{run.attempt_number}차 / 최대 3차</dd>
    <dt>접수</dt><dd>{documentTime(run.requested_at)}</dd><dt>시작</dt><dd>{documentTime(run.started_at)}</dd><dt>종료</dt><dd>{documentTime(run.finished_at)}</dd>
    <dt>소요 시간</dt><dd>{documentDuration(run.elapsed_ms)}</dd><dt>추출기 버전</dt><dd>{run.extractor_version||'기록 없음'}</dd><dt>파일 해시</dt><dd>{run.file_hash||'기록 없음'}</dd>
   </dl></section>
   <section className="extraction-card"><h2>마지막 처리 상태</h2><dl className="extraction-data">
    <dt>단계</dt><dd>{run.stage?extractionStages[run.stage]:'기록 없음'}</dd><dt>단계 시작</dt><dd>{documentTime(run.stage_started_at)}</dd><dt>마지막 진행</dt><dd>{documentTime(run.last_progress_at)}</dd>
    <dt>처리 중 페이지</dt><dd>{run.current_page??'기록 없음'}</dd><dt>완료 페이지</dt><dd>{run.completed_pages??'기록 없음'} / {run.total_pages??'기록 없음'}</dd>
    <dt>추출 결과</dt><dd>{run.page_count??'기록 없음'}페이지 · {run.character_count??'기록 없음'}자</dd>
    <dt>다음 시도 예정</dt><dd>{documentTime(detail.chain.find(item=>item.retry_of===run.id)?.next_attempt_at??run.next_attempt_at)}</dd>
   </dl><p className="extraction-meta">마지막 진행 시각은 실제 처리 이벤트 기준입니다. 프로세스 생존이나 오류 원인을 확정하는 정보는 아닙니다.</p>
   {run.status==='no_text'&&<p>추출된 텍스트가 없습니다. 스캔 문서 여부는 현재 정보만으로 확정할 수 없습니다.</p>}</section>
  </div>
  <section className="extraction-card" style={{marginTop:24}}><h2>오류 진단</h2>
   {run.error?<p className="extraction-diagnostic"><strong>{run.error_code}</strong><br/>{run.error}</p>:<p>저장된 오류 안내가 없습니다.</p>}
   {run.diagnostic_error?<details className="extraction-diagnostic"><summary>기술 정보 펼쳐보기</summary><pre>{JSON.stringify(run.diagnostic_error,null,2)}</pre></details>:<p className="extraction-meta">상세 진단 정보가 기록되지 않았습니다.</p>}
  </section>
  <section className="extraction-card" style={{marginTop:24}}><h2>재시도 흐름</h2><ol>{detail.chain.map(item=><li key={item.id}><a href={`/admin/document-extractions/${item.id}`} aria-current={item.id===run.id?'page':undefined}>{item.attempt_number}차 · {runStatuses[item.status]}</a> · {documentTime(item.requested_at)}{item.error_code&&` · ${item.error_code}`}</li>)}</ol></section>
  {!!run.page_count&&<DocumentBodyViewer noticeKey={run.notice_key} documentId={run.document_id} runId={run.id} pageCount={run.page_count}/>}
 </>;
}
