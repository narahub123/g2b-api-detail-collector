// @vitest-environment jsdom
import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {DocumentPanel} from './DocumentPanel';
const key='R26BK01797756--001';
const docs=[{id:'a',filename:'공고.pdf',seq:1,is_current:true,attachment_url:'/original-a',latest:{id:'a-run',status:'failed',error:'최근 실패'},success:{id:'a-ok',status:'completed',page_count:2,character_count:20}},
{id:'b',filename:'공고.pdf',seq:2,is_current:true,attachment_url:'/original-b',latest:null,success:null}];
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
it('같은 이름의 파일도 독립적으로 펼치고 본문을 지연 조회하며 페이지 선택을 유지합니다',async()=>{
 const fetcher=vi.fn(async(input:string,init?:RequestInit)=>{
  if(init?.method==='POST')return Response.json({id:'b-run',awake:false},{status:202});
  if(input.includes('/pages/'))return Response.json({pageNumber:Number(input.match(/pages\/(\d+)/)?.[1]),text:input.includes('/pages/2')?'두 번째 본문':'참가 자격 <script>'});
  if(input.includes('/extractions/a-ok'))return Response.json({...docs[0].success,filename:'공고.pdf'});
  if(input.includes('/extractions'))return Response.json({runs:[],nextCursor:null});
  return Response.json({documents:docs,unsupported:[]});
 });vi.stubGlobal('fetch',fetcher);
 render(<DocumentPanel noticeKey={key}/>);
 const title=await screen.findByText(/1\. 공고.pdf/);expect(fetcher.mock.calls.some(([url])=>url.includes('/pages/'))).toBe(false);
 fireEvent.click(title.closest('summary')!);await screen.findByText('참가 자격 <script>');expect(document.querySelector('script')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'다음'}));await screen.findByText('두 번째 본문');
 fireEvent.click(title.closest('summary')!);fireEvent.click(title.closest('summary')!);await screen.findByText('두 번째 본문');
 fireEvent.click(screen.getByText(/2\. 공고.pdf/).closest('summary')!);
 fireEvent.click(await screen.findByRole('button',{name:'추출 요청'}));await screen.findByText(/작업기에 연결하지 못했지만/);
 expect(screen.getByText('두 번째 본문')).toBeInTheDocument();
});
it('PDF가 없으면 실패 대신 빈 상태를 표시합니다',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({documents:[],unsupported:[]})));
 render(<DocumentPanel noticeKey={key}/>);await screen.findByText(/직접 첨부된 PDF가 없습니다/);
});
it('다시 연 이력의 새 cursor를 이전 페이지 응답이 덮어쓰지 않습니다',async()=>{
 let firstPages=0,resolveOld!:(value:Response)=>void;
 const fetcher=vi.fn(async(input:string)=>{
  if(input.includes('cursor=old'))return new Promise<Response>(resolve=>{resolveOld=resolve;});
  if(input.includes('cursor=new'))return Response.json({runs:[],nextCursor:null});
  if(input.includes('/pages/'))return Response.json({text:'본문'});
  if(input.includes('/extractions/a-ok'))return Response.json({...docs[0].success,id:'a-ok'});
  if(input.includes('/extractions')){firstPages++;return Response.json({runs:[{id:'a-ok',status:'completed',requested_at:'2026-10-29',attempt_number:1}],nextCursor:firstPages===1?'old':'new'});}
  return Response.json({documents:[docs[0]],unsupported:[]});
 });vi.stubGlobal('fetch',fetcher);render(<DocumentPanel noticeKey={key}/>);
 const title=await screen.findByText(/1\. 공고.pdf/);fireEvent.click(title.closest('summary')!);
 fireEvent.click(await screen.findByRole('button',{name:'이전 이력 더 보기'}));
 await waitFor(()=>expect(resolveOld).toBeTypeOf('function'));
 fireEvent.click(title.closest('summary')!);await waitFor(()=>expect(title.closest('details')).not.toHaveAttribute('open'));
 fireEvent.click(title.closest('summary')!);await waitFor(()=>expect(firstPages).toBe(2));
 await act(async()=>resolveOld(Response.json({runs:[],nextCursor:null})));
 fireEvent.click(screen.getByRole('button',{name:'이전 이력 더 보기'}));
 await waitFor(()=>expect(fetcher.mock.calls.some(([url])=>url.includes('cursor=new'))).toBe(true));
});
it('닫힌 파일은 현재 실행과 본문 폴링을 멈추고 목록 요약만 갱신합니다',async()=>{
 const processing={id:'active',status:'processing',requested_at:'2026-10-29'};
 const fetcher=vi.fn(async(input:string)=>{
  if(input.includes('/pages/'))return Response.json({text:'저장 본문'});
  if(input.includes('/extractions/active'))return Response.json(processing);
  if(input.includes('/extractions/a-ok'))return Response.json({...docs[0].success,id:'a-ok'});
  if(input.includes('/extractions'))return Response.json({runs:[],nextCursor:null});
  return Response.json({documents:[{...docs[0],active:processing,latest:processing}],unsupported:[]});
 });vi.stubGlobal('fetch',fetcher);vi.useFakeTimers();render(<DocumentPanel noticeKey={key}/>);
 await act(async()=>vi.advanceTimersByTimeAsync(0));
 const title=screen.getByText(/1\. 공고.pdf/),opened=title.closest('details')!;opened.open=true;fireEvent(opened,new Event('toggle'));
 await act(async()=>vi.advanceTimersByTimeAsync(0));expect(screen.getByText('저장 본문')).toBeInTheDocument();
 await act(async()=>vi.advanceTimersByTimeAsync(2100));
 expect(fetcher.mock.calls.some(([url])=>url.includes('/extractions/active'))).toBe(true);
 const details=title.closest('details')!;details.open=false;fireEvent(details,new Event('toggle'));
 const bodyCalls=fetcher.mock.calls.filter(([url])=>url.includes('/pages/')||url.includes('/extractions/active')).length;
 await act(async()=>vi.advanceTimersByTimeAsync(11000));
 expect(fetcher.mock.calls.filter(([url])=>url.includes('/pages/')||url.includes('/extractions/active'))).toHaveLength(bodyCalls);
 expect(fetcher.mock.calls.filter(([url])=>url.includes('/documents?')).length).toBeGreaterThan(1);
});
