// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DocumentExtractionDetail} from './DocumentExtractionDetail';
import type {HistoryDetail} from '@/lib/documents/history-store';
const initial={run:{id:'run',document_id:'doc',notice_key:'key',filename:'공고.pdf',document_type:'pdf',status:'processing',source:'manual',attempt_number:1,stage:'extracting',has_content:true,page_count:2,current_page:2,completed_pages:1,total_pages:2,requested_at:'2026-10-30T00:00:00Z',diagnostic_error:null},chain:[]} as unknown as HistoryDetail;
beforeEach(()=>{vi.spyOn(window,'scrollTo').mockImplementation(()=>{});});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('추출 본문 제목과 같은 헤더에 재추출과 본문 조회를 배치합니다',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({text:'저장된 본문'})));
 render(<DocumentExtractionDetail initial={{...initial,run:{...initial.run,status:'completed'},requestState:{canRequest:true,reason:null,active:null}}}/>);
 const heading=screen.getByRole('heading',{name:'추출 본문'}),header=heading.closest('header')!;
 expect(header).not.toBeNull();
 expect(within(header).getByRole('button',{name:'재추출'})).toBeInTheDocument();
 fireEvent.click(within(header).getByRole('button',{name:'본문 조회'}));await screen.findByText('저장된 본문');
 expect(within(header).queryByRole('button',{name:'본문 조회'})).not.toBeInTheDocument();
 expect(within(header).getByRole('button',{name:'재추출'})).toBeInTheDocument();
});
it('본문이 정리된 과거 성공 이력은 현재 공고로 안내합니다',()=>{
 render(<DocumentExtractionDetail initial={{...initial,run:{...initial.run,status:'completed',has_content:false}}}/>);
 expect(screen.queryByRole('button',{name:'본문 조회'})).not.toBeInTheDocument();
 expect(screen.getByText(/현재 성공 본문만 보관/)).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'현재 본문 확인'})).toHaveAttribute('href','/admin/bids/key');
});
it('본문 보관 여부가 없는 이전 응답으로 과거 본문을 요청하지 않습니다',()=>{
 render(<DocumentExtractionDetail initial={{...initial,run:{...initial.run,status:'completed',has_content:undefined}}}/>);
 expect(screen.queryByRole('button',{name:'본문 조회'})).not.toBeInTheDocument();
});
it('진단 요약을 표시하고 본문은 요청하기 전까지 읽지 않습니다',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>new Response(JSON.stringify({text:'첫 페이지 본문'})));vi.stubGlobal('fetch',fetch);
 render(<DocumentExtractionDetail initial={{...initial,run:{...initial.run,status:'completed',elapsed_ms:1200}}}/>);
 expect(screen.getByText('텍스트 추출')).toBeInTheDocument();expect(fetch).not.toHaveBeenCalled();
 expect(screen.queryByRole('button',{name:'다음 페이지'})).not.toBeInTheDocument();
 expect(screen.queryByRole('button',{name:'이전 페이지'})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));expect(await screen.findByText('첫 페이지 본문')).toBeInTheDocument();
 expect(fetch.mock.calls[0][0]).toContain('/pages/1?key=key');
 expect(screen.queryByRole('button',{name:'본문 조회'})).not.toBeInTheDocument();
});
it('5초마다 진행을 확인하고 완료되면 폴링을 중단합니다',async()=>{
 vi.useFakeTimers();const fetch=vi.fn(async()=>new Response(JSON.stringify({...initial,run:{...initial.run,status:'completed'}})));vi.stubGlobal('fetch',fetch);
 render(<DocumentExtractionDetail initial={initial}/>);
 await act(()=>vi.advanceTimersByTimeAsync(5000));expect(fetch).toHaveBeenCalledTimes(1);
 await act(()=>vi.advanceTimersByTimeAsync(15000));expect(fetch).toHaveBeenCalledTimes(1);
});
it('본문 아래에서도 페이지를 이동하고 위아래 표시와 경계를 함께 갱신합니다',async()=>{
 const fetch=vi.fn<typeof globalThis.fetch>(async input=>new Response(JSON.stringify({text:String(input).includes('/pages/2?')?'두 번째 본문':'첫 번째 본문'})));vi.stubGlobal('fetch',fetch);
 render(<DocumentExtractionDetail initial={{...initial,run:{...initial.run,status:'completed'}}}/>);
 fireEvent.click(screen.getByRole('button',{name:'본문 조회'}));await screen.findByText('첫 번째 본문');
 const lower=screen.getByRole('navigation',{name:'본문 아래 페이지 이동'});
 expect(within(lower).queryByRole('button',{name:'본문 조회'})).not.toBeInTheDocument();
 expect(within(lower).getByRole('button',{name:'이전 페이지'})).toBeDisabled();
 fireEvent.click(within(lower).getByRole('button',{name:'다음 페이지'}));await screen.findByText('두 번째 본문');
 expect(screen.getAllByText('2 / 2')).toHaveLength(2);
 for(const button of screen.getAllByRole('button',{name:'다음 페이지'}))expect(button).toBeDisabled();
});
