// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DocumentFileDetail} from './DocumentFileDetail';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DocumentFileDetail as FileDetail} from '@/lib/documents/history-store';
import type {RunMetadata} from '@/lib/documents/model';
const run={id:'latest',status:'failed',source:'manual',purpose:'reextract',attempt_number:1,requested_at:'2026-11-02T00:00:00Z'} as RunMetadata;
const initial:FileDetail={id:'doc',notice_key:'notice--001',filename:'현재.pdf',document_type:'pdf',attachment_url:null,latest:run,
 content:{run_id:'success',page_count:2,finished_at:'2026-11-01T00:00:00Z'},requestState:{canRequest:true,reason:null,active:null}};
beforeEach(()=>vi.spyOn(window,'scrollTo').mockImplementation(()=>{}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('서버 렌더링에서도 현재 본문의 출처를 표시합니다',()=>{
 const html=renderToStaticMarkup(<DocumentFileDetail initial={initial} initialHistory={{runs:[run],nextCursor:null}}/>);
 expect(html).toContain('현재 보관된 성공 본문');expect(html).toContain('/admin/document-extractions/success');
});
it('대기 중에도 헤더의 재추출 버튼은 비활성 상태로 유지하고 안내와 출처는 아래에 표시합니다',()=>{
 render(<DocumentFileDetail initial={{...initial,requestState:{canRequest:false,reason:'이미 대기 또는 처리 중인 요청이 있습니다.',active:{id:'queued-run',status:'queued'}}}} initialHistory={{runs:[run],nextCursor:null}}/>);
 const header=screen.getByRole('heading',{name:'추출 본문'}).closest('header')!;
 expect(within(header).getByRole('button',{name:'재추출'})).toBeDisabled();
 expect(within(header).getByRole('button',{name:'본문 조회'})).toBeEnabled();
 expect(header).not.toContainElement(screen.getByRole('link',{name:'본문 출처 실행 확인'}));
 expect(header).not.toContainElement(screen.getByRole('link',{name:'진행 중인 실행 확인'}));
 expect(screen.getByRole('link',{name:'진행 중인 실행 확인'}).closest('.extraction-body-section')).not.toBeNull();
});
it('최신 실패와 별도로 현재 성공 본문을 조회하고 전체 이력 링크를 표시합니다',async()=>{
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json({text:'현재 성공 본문'}));vi.stubGlobal('fetch',fetcher);
 render(<DocumentFileDetail initial={initial} initialHistory={{runs:[run,{...run,id:'another-chain',source:'automatic'}],nextCursor:null}}/>);
 expect(screen.getByRole('heading',{name:'추출 이력'})).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'본문 출처 실행 확인'})).toHaveAttribute('href','/admin/document-extractions/success');
 expect(screen.getAllByRole('link',{name:'실행 상세'})).toHaveLength(2);
 const header=screen.getByRole('heading',{name:'추출 본문'}).closest('header')!;
 expect(within(header).getByRole('button',{name:'재추출'})).toBeInTheDocument();
 fireEvent.click(within(header).getByRole('button',{name:'본문 조회'}));await screen.findByText('현재 성공 본문');
 expect(String(fetcher.mock.calls[0][0])).toContain('/extractions/success/pages/1');
 expect(screen.queryByRole('button',{name:'본문 조회'})).not.toBeInTheDocument();
});
it('미요청 파일도 빈 이력과 추출 요청을 제공하고 접수 후 파일 상세에 머뭅니다',async()=>{
 const file={...initial,latest:null,content:null};
 vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(_url,init)=>init?.method==='POST'?Response.json({id:'new',awake:false},{status:202}):String(_url).includes('/files/')?Response.json({...file,requestState:{canRequest:false,reason:'대기 중',active:{id:'new',status:'queued'}}}):Response.json({runs:[],nextCursor:null})));
 render(<DocumentFileDetail initial={file} initialHistory={{runs:[],nextCursor:null}}/>);
 expect(screen.getByText('추출 이력이 없습니다.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'본문 조회'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'추출 요청'}));await screen.findByRole('link',{name:'접수한 실행 확인'});
 expect(screen.getByRole('heading',{name:'첨부파일 상세'})).toBeInTheDocument();
});
it('이전 이력을 펼친 뒤 폴링해도 과거 이력을 보존하고 완료 시 본문을 교체합니다',async()=>{
 vi.useFakeTimers();let completed=false;
 const active={...initial,requestState:{canRequest:false,reason:'처리 중',active:{id:run.id,status:'processing' as const}}};
 const fetcher=vi.fn<typeof fetch>(async url=>{
  const input=String(url);
  if(input.includes('/pages/'))return Response.json({text:'이전 성공 본문'});
  if(input.includes('cursor='))return Response.json({runs:[{...run,id:'older'}],nextCursor:'tail'});
  if(input.includes('/files/'))return Response.json(completed?{...initial,content:{...initial.content,run_id:'new-success'}}:active);
  return Response.json({runs:[{...run,status:completed?'completed':'processing'}],nextCursor:'first'});
 });vi.stubGlobal('fetch',fetcher);
 render(<DocumentFileDetail initial={active} initialHistory={{runs:[run],nextCursor:'first'}}/>);
 fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await act(async()=>{});expect(screen.getByText('이전 성공 본문')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'이전 이력 더 보기'}));await act(async()=>{});
 await act(()=>vi.advanceTimersByTimeAsync(5000));expect(screen.getAllByRole('link',{name:'실행 상세'})).toHaveLength(2);
 completed=true;await act(()=>vi.advanceTimersByTimeAsync(5000));
 expect(screen.queryByText('이전 성공 본문')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'본문 조회'})).toBeInTheDocument();
 const calls=fetcher.mock.calls.length;await act(()=>vi.advanceTimersByTimeAsync(15000));expect(fetcher.mock.calls).toHaveLength(calls);
 expect(screen.getAllByRole('link',{name:'실행 상세'})).toHaveLength(2);
});

/** 실제 페이지 경계에서 신규 실행 삽입을 검증할 최신순 이력을 만듭니다. */
function historyRun(index:number):RunMetadata{
 return {...run,id:`history-${index}`,status:'completed',requested_at:new Date(Date.UTC(2026,10,2)-index*1000).toISOString()};
}

/** 화면에 표시된 실행 ID의 순서와 중복을 함께 검증합니다. */
function displayedRuns():string[]{
 return screen
   .getAllByRole("link", { name: "실행 상세" })
   .map((link) => link.getAttribute("href")!.split("/").at(-1)!);
}

it('과거 이력 40건을 펼친 상태에서 재추출을 접수해도 이력과 다음 조회 위치를 유지합니다',async()=>{
 const first=Array.from({length:20},(_,index)=>historyRun(index));
 const older=Array.from({length:20},(_,index)=>historyRun(index+20));
 const newest={...historyRun(-1),id:'new-run',status:'queued' as const};
 const cursors:string[]=[];
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  if(init?.method==='POST')return Response.json({id:newest.id,awake:true},{status:202});
  if(String(url).includes('/files/'))return Response.json({...initial,latest:newest,requestState:{canRequest:false,reason:'대기 중',active:{id:newest.id,status:'queued'}}});
  const cursor=new URL(String(url),'http://localhost').searchParams.get('cursor');
  if(cursor){cursors.push(cursor);return Response.json(cursor==='page-two'?{runs:older,nextCursor:'page-three'}:{runs:[historyRun(40)],nextCursor:null});}
  return Response.json({runs:[newest,...first.slice(0,19)],nextCursor:'shifted-first-page'});
 });vi.stubGlobal('fetch',fetcher);
 render(<DocumentFileDetail initial={{...initial,latest:first[0]}} initialHistory={{runs:first,nextCursor:'page-two'}}/>);
 fireEvent.click(screen.getByRole('button',{name:'이전 이력 더 보기'}));await act(async()=>{});
 expect(displayedRuns()).toEqual([...first,...older].map(item=>item.id));
 fireEvent.click(screen.getByRole('button',{name:'재추출'}));await act(async()=>{});
 expect(displayedRuns()).toEqual([newest,...first,...older].map(item=>item.id));
 expect(new Set(displayedRuns()).size).toBe(41);
 fireEvent.click(screen.getByRole('button',{name:'이전 이력 더 보기'}));await act(async()=>{});
 expect(cursors).toEqual(['page-two','page-three']);
 expect(displayedRuns()).toEqual([newest,...first,...older,historyRun(40)].map(item=>item.id));
 expect(screen.queryByRole('button',{name:'이전 이력 더 보기'})).not.toBeInTheDocument();
});

it('과거 페이지의 늦은 응답이 신규 실행 폴링 결과를 지우거나 중복시키지 않습니다',async()=>{
 vi.useFakeTimers();
 const first=Array.from({length:20},(_,index)=>historyRun(index));
 const newest={...historyRun(-1),id:'new-automatic-run',status:'processing' as const};
 const active={...initial,latest:first[0],requestState:{canRequest:false,reason:'처리 중',active:{id:first[0].id,status:'processing' as const}}};
 let resolveOlder!:(response:Response)=>void;
 const slowOlder=new Promise<Response>(resolve=>{resolveOlder=resolve;});
 vi.stubGlobal('fetch',vi.fn<typeof fetch>(async url=>{
  if(String(url).includes('cursor='))return slowOlder;
  if(String(url).includes('/files/'))return Response.json({...active,latest:newest,requestState:{...active.requestState,active:{id:newest.id,status:'processing'}}});
  return Response.json({runs:[newest,...first.slice(0,19)],nextCursor:'shifted-first-page'});
 }));
 render(<DocumentFileDetail initial={active} initialHistory={{runs:first,nextCursor:'page-two'}}/>);
 fireEvent.click(screen.getByRole('button',{name:'이전 이력 더 보기'}));
 expect(screen.getByRole('button',{name:'이력 조회 중…'})).toBeDisabled();
 await act(()=>vi.advanceTimersByTimeAsync(5000));
 expect(displayedRuns()).toEqual([newest,...first].map(item=>item.id));
 await act(async()=>{resolveOlder(Response.json({runs:[first[19],historyRun(20)],nextCursor:'page-three'}));});
 expect(displayedRuns()).toEqual([newest,...first,historyRun(20)].map(item=>item.id));
 expect(new Set(displayedRuns()).size).toBe(22);
 expect(screen.getByRole('button',{name:'이전 이력 더 보기'})).toBeEnabled();
});
