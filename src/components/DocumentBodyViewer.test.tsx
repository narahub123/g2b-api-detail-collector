// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DocumentExtractionDetail} from './DocumentExtractionDetail';
import type {HistoryDetail} from '@/lib/documents/history-store';

const initial={run:{id:'run',document_id:'doc',notice_key:'notice',filename:'자료.pdf',status:'completed',source:'manual',page_count:3,requested_at:'2026-10-30T00:00:00Z',diagnostic_error:null},chain:[]} as unknown as HistoryDetail;

/** 취소를 무시하고 도착하는 응답도 검증할 수 있도록 완료 시점을 제어합니다. */
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(r=>{resolve=r;});return {promise,resolve};}
/** 본문 상단 컨트롤에서만 페이지 이동을 실행합니다. */
function next(){fireEvent.click(within(screen.getByRole('navigation',{name:'본문 위 페이지 이동'})).getByRole('button',{name:'다음 페이지'}));}
/** 본문 하단 컨트롤에서만 이전 페이지로 이동합니다. */
function previous(){fireEvent.click(within(screen.getByRole('navigation',{name:'본문 아래 페이지 이동'})).getByRole('button',{name:'이전 페이지'}));}
/** API 성공 응답을 만듭니다. */
function response(text:string){return new Response(JSON.stringify({text}));}

beforeEach(()=>{vi.spyOn(window,'scrollTo').mockImplementation(()=>{});});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('느린 응답 동안 본문·번호·내부 스크롤을 유지하고 성공할 때 함께 교체합니다',async()=>{
 const slow=deferred(),fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response('첫 본문')).mockReturnValueOnce(slow.promise);vi.stubGlobal('fetch',fetch);
 render(<DocumentExtractionDetail initial={initial}/>);fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await screen.findByText('첫 본문');
 const body=screen.getByText('첫 본문');body.scrollTop=80;next();
 expect(screen.getByText('첫 본문')).toBeInTheDocument();expect(body.scrollTop).toBe(80);expect(screen.getAllByText('1 / 3')).toHaveLength(2);
 expect(screen.getByRole('status')).toHaveTextContent('2페이지를 불러오는 중');
 expect(screen.getAllByRole('button',{name:'다음 페이지'}).every(button=>(button as HTMLButtonElement).disabled)).toBe(true);
 await act(async()=>{slow.resolve(response('둘째 본문'));});
 expect(screen.getByText('둘째 본문')).toBeInTheDocument();expect(screen.getAllByText('2 / 3')).toHaveLength(2);expect(screen.getByText('둘째 본문').scrollTop).toBe(0);
});

it('캐시된 페이지는 빈 문자열도 포함하여 추가 호출 없이 번호와 함께 전환합니다',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response('')).mockResolvedValueOnce(response('둘째 본문'));vi.stubGlobal('fetch',fetch);
 render(<DocumentExtractionDetail initial={initial}/>);fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await screen.findByText('이 페이지에는 추출된 텍스트가 없습니다.');
 next();await screen.findByText('둘째 본문');previous();expect(screen.getByText('이 페이지에는 추출된 텍스트가 없습니다.')).toBeInTheDocument();expect(screen.getAllByText('1 / 3')).toHaveLength(2);
 next();expect(screen.getByText('둘째 본문')).toBeInTheDocument();expect(screen.getAllByText('2 / 3')).toHaveLength(2);expect(fetch).toHaveBeenCalledTimes(2);
});

it('전환 실패는 기존 본문과 번호를 유지하며 실패한 대상만 다시 요청합니다',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response('첫 본문')).mockResolvedValueOnce(new Response('{}',{status:503})).mockResolvedValueOnce(response('둘째 본문'));vi.stubGlobal('fetch',fetch);
 render(<DocumentExtractionDetail initial={initial}/>);fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await screen.findByText('첫 본문');next();
 await screen.findByRole('button',{name:'다시 시도'});expect(screen.getByText('첫 본문')).toBeInTheDocument();expect(screen.getAllByText('1 / 3')).toHaveLength(2);
 fireEvent.click(screen.getByRole('button',{name:'다시 시도'}));await screen.findByText('둘째 본문');expect(String(fetch.mock.calls[2][0])).toContain('/pages/2?');
});

it('최초 실패 후에는 이동 버튼 없이 본문 조회를 다시 실행할 수 있습니다',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new Error('네트워크 오류')).mockResolvedValueOnce(response('재조회 본문'));vi.stubGlobal('fetch',fetch);
 render(<DocumentExtractionDetail initial={initial}/>);fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await screen.findByRole('alert');
 expect(screen.queryByRole('button',{name:'다음 페이지'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await screen.findByText('재조회 본문');
});

it('실행 변경 시 캐시와 요청을 해제하고 취소를 무시한 이전 응답도 버립니다',async()=>{
 const old=deferred(),fetch=vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response('새 실행 본문'));vi.stubGlobal('fetch',fetch);
 const {rerender}=render(<DocumentExtractionDetail initial={initial}/>);fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));
 rerender(<DocumentExtractionDetail initial={{...initial,run:{...initial.run,id:'new-run'}}}/>);
 expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await screen.findByText('새 실행 본문');
 await act(async()=>{old.resolve(response('폐기할 본문'));});expect(screen.queryByText('폐기할 본문')).not.toBeInTheDocument();expect(screen.getByText('새 실행 본문')).toBeInTheDocument();
});

it.each([false,true])('응답 보정은 사용자 스크롤 의도(%s)를 존중합니다',async moved=>{
 const slow=deferred();vi.stubGlobal('fetch',vi.fn<typeof globalThis.fetch>().mockReturnValue(slow.promise));
 render(<DocumentExtractionDetail initial={initial}/>);
 const section=screen.getByRole('heading',{name:'추출 본문'}).closest('section')!;
 let top=16;vi.spyOn(section,'getBoundingClientRect').mockImplementation(()=>({top} as DOMRect));
 fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));expect(window.scrollTo).toHaveBeenCalledTimes(1);
 if(moved)fireEvent.wheel(window,{deltaY:100});top=80;
 await act(async()=>{slow.resolve(response('본문'));});
 expect(window.scrollTo).toHaveBeenCalledTimes(moved?1:2);
});

it('응답 후 위치가 유지되면 추가 스크롤을 하지 않고 해제 시 요청을 취소합니다',async()=>{
 const slow=deferred(),fetch=vi.fn<typeof globalThis.fetch>().mockReturnValue(slow.promise);vi.stubGlobal('fetch',fetch);
 const {unmount}=render(<DocumentExtractionDetail initial={initial}/>);
 const section=screen.getByRole('heading',{name:'추출 본문'}).closest('section')!;vi.spyOn(section,'getBoundingClientRect').mockReturnValue({top:16} as DOMRect);
 fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await act(async()=>{slow.resolve(response('본문'));});expect(window.scrollTo).toHaveBeenCalledTimes(1);
 unmount();expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

it('진단 폴링 성공이 본문 조회 오류를 지우지 않습니다',async()=>{
 vi.useFakeTimers();
 const fetch=vi.fn<typeof globalThis.fetch>(async input=>String(input).includes('/pages/')?new Response('{}',{status:503}):new Response(JSON.stringify(initial)));vi.stubGlobal('fetch',fetch);
 render(<DocumentExtractionDetail initial={{...initial,run:{...initial.run,status:'processing'}}}/>);
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));});
 expect(screen.getByRole('alert')).toHaveTextContent('저장된 본문을 조회하지 못했습니다.');
 await act(()=>vi.advanceTimersByTimeAsync(5000));
 expect(fetch).toHaveBeenCalledTimes(2);expect(screen.getByRole('alert')).toHaveTextContent('저장된 본문을 조회하지 못했습니다.');
});

it('화면을 떠났다가 돌아오면 이전 메모리 캐시를 재사용하지 않습니다',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>response('본문'));vi.stubGlobal('fetch',fetch);
 const first=render(<DocumentExtractionDetail initial={initial}/>);fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await screen.findByText('본문');first.unmount();
 render(<DocumentExtractionDetail initial={initial}/>);expect(screen.queryByText('본문')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await screen.findByText('본문');expect(fetch).toHaveBeenCalledTimes(2);
});
