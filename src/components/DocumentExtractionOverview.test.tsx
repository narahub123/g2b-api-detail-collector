// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DocumentExtractionOverview} from './DocumentExtractionOverview';
import {emptyDocumentCounts,emptyWorkflowCounts} from '@/lib/documents/overview';
import type {DocumentOverview} from '@/lib/documents/overview';

/** 총계와 유형별 표시를 실제 DOM에서 확인할 최소 현황을 만듭니다. */
function fixture():DocumentOverview{
 return {generatedAt:'2026-10-30T00:00:00Z',totals:{...emptyDocumentCounts(),total:2,processing:1,completed:1},
  byType:[{type:'pdf',counts:{...emptyDocumentCounts(),total:1,processing:1}},{type:'hwp',counts:{...emptyDocumentCounts(),total:1,completed:1}}],
  workflow:{totals:{...emptyWorkflowCounts(),processing:1,stages:{...emptyWorkflowCounts().stages,extracting:1}},
   byType:[{type:'pdf',...emptyWorkflowCounts(),processing:1,stages:{...emptyWorkflowCounts().stages,extracting:1}},{type:'hwp',...emptyWorkflowCounts()}],
   processing:[{id:'run-pdf',filename:'공고.pdf',type:'pdf',stage:'extracting',stage_started_at:null,last_progress_at:null,current_page:2,completed_pages:1,total_pages:4}]}};
}
const fetcher=vi.fn();
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('fetch',fetcher);Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});fetcher.mockResolvedValue({ok:true,json:async()=>fixture()});});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.resetAllMocks();});

it('전체와 유형별 카드는 첫 페이지의 최신 파일 목록 링크와 선택 표시를 제공합니다',()=>{
 const initial=fixture();initial.byType.push({type:null,counts:{...emptyDocumentCounts(),total:1,unrequested:1}});
 render(<DocumentExtractionOverview initial={initial} selection={{type:'pdf',status:'failed'}}/>);
 expect(screen.getByRole('link',{name:'전체 문서 실패 0개 보기'})).toHaveAttribute('href','/admin/document-extractions?view=documents&status=failed#extraction-results');
 expect(screen.getByRole('link',{name:'전체 문서 등록 파일 2개 보기'})).toHaveAttribute('href','/admin/document-extractions?view=documents#extraction-results');
 const pdf=screen.getByRole('link',{name:'PDF 실패 0개 보기',hidden:true});
 expect(pdf).toHaveAttribute('href','/admin/document-extractions?view=documents&type=pdf&status=failed#extraction-results');
 expect(pdf).toHaveAttribute('aria-current','true');
 expect(screen.getByRole('link',{name:'HWP 등록 파일 1개 보기',hidden:true})).toHaveAttribute('href','/admin/document-extractions?view=documents&type=hwp#extraction-results');
 expect(screen.getByRole('link',{name:'형식 기록 없음 미요청 1개 보기',hidden:true})).toHaveAttribute('href','/admin/document-extractions?view=documents&type=__unknown__&status=unrequested#extraction-results');
});

it('전체 통계·다른 문서 유형과 파일별 페이지 진행을 표시합니다',()=>{
 render(<DocumentExtractionOverview initial={fixture()}/>);
 const totals=screen.getByRole('region',{name:'전체 누적 현황'});
 expect(within(totals).getByText('등록 파일')).toBeInTheDocument();expect(within(totals).getByText('2')).toBeInTheDocument();
 expect(screen.getByText('PDF · 등록 1개').closest('details')).not.toHaveAttribute('open');
 expect(screen.getByText('HWP · 등록 1개')).toBeInTheDocument();
 expect(screen.getByText('추출 대기열·작업 진행 현황').closest('details')).toHaveAttribute('open');
 fireEvent.click(screen.getByText('PDF · 대기 0개 · 처리 1개'));
 expect(screen.getByRole('link',{name:'공고.pdf'})).toHaveAttribute('href','/admin/document-extractions/run-pdf');
 expect(screen.getByRole('progressbar',{name:'공고.pdf 페이지 진행률'})).toHaveAttribute('value','1');
 expect(screen.getByText('1 / 4페이지')).toBeInTheDocument();
 expect(screen.getByText('현재 처리 페이지 2')).toBeInTheDocument();
});

it('실패해도 마지막 통계와 열림 상태를 유지하고 다음 주기에 복구합니다',async()=>{
 render(<DocumentExtractionOverview initial={fixture()}/>);
 const summary=screen.getByText('PDF · 등록 1개');fireEvent.click(summary);
 fetcher.mockRejectedValueOnce(new Error('secret'));
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(screen.getByRole('alert')).toHaveTextContent('현황을 갱신하지 못했습니다');
 expect(summary.closest('details')).toHaveAttribute('open');
 expect(within(screen.getByRole('region',{name:'전체 누적 현황'})).getByText('2')).toBeInTheDocument();
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(summary.closest('details')).toHaveAttribute('open');
});

it('작업이 없어도 갱신하며 탭 숨김·복귀와 이탈 시 요청을 취소합니다',async()=>{
 const initial=fixture();initial.workflow={totals:emptyWorkflowCounts(),byType:[],processing:[]};
 const {unmount}=render(<DocumentExtractionOverview initial={initial}/>);
 expect(screen.getByText('현재 대기 중이거나 처리 중인 문서가 없습니다.')).toBeInTheDocument();
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(fetcher).toHaveBeenCalledTimes(1);
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});fireEvent(document,new Event('visibilitychange'));
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(fetcher).toHaveBeenCalledTimes(1);
 let signal:AbortSignal;
 fetcher.mockImplementation((_url:string,options:{signal:AbortSignal})=>{signal=options.signal;return new Promise(()=>{});});
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 await act(async()=>{fireEvent(document,new Event('visibilitychange'));});
 expect(fetcher).toHaveBeenCalledTimes(2);
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(fetcher).toHaveBeenCalledTimes(2);
 unmount();expect(signal!.aborted).toBe(true);
});

it('초기 조회 실패 후에도 복구하고 페이지 없는 유형에는 진행 막대를 만들지 않습니다',async()=>{
 const next=fixture();next.workflow.processing[0]={...next.workflow.processing[0],total_pages:null,completed_pages:null,stage:null};
 fetcher.mockResolvedValue({ok:true,json:async()=>next});
 render(<DocumentExtractionOverview initial={null} initialError="현황 초기 조회 실패"/>);
 expect(screen.getByRole('alert')).toHaveTextContent('현황 초기 조회 실패');
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 expect(screen.queryByRole('alert')).not.toBeInTheDocument();
 fireEvent.click(screen.getByText('PDF · 대기 0개 · 처리 1개'));
 expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
 expect(screen.getByText('현재 처리 페이지 2')).toBeInTheDocument();
 expect(screen.getAllByText('단계 기록 없음').length).toBeGreaterThan(0);
});

it('탭을 숨길 때 진행 중인 요청을 취소하고 늦은 응답을 무시합니다',async()=>{
 let firstSignal:AbortSignal|undefined,finish:((value:unknown)=>void)|undefined;
 fetcher.mockImplementationOnce((_url:string,options:{signal:AbortSignal})=>{firstSignal=options.signal;return new Promise(resolve=>{finish=resolve;});});
 render(<DocumentExtractionOverview initial={fixture()}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});fireEvent(document,new Event('visibilitychange'));
 expect(firstSignal?.aborted).toBe(true);
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 await act(async()=>{fireEvent(document,new Event('visibilitychange'));});
 const stale=fixture();stale.totals.total=999;
 await act(async()=>{finish!({ok:true,json:async()=>stale});});
 expect(within(screen.getByRole('region',{name:'전체 누적 현황'})).queryByText('999')).not.toBeInTheDocument();
 await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});expect(fetcher).toHaveBeenCalledTimes(3);
});
