// @vitest-environment jsdom
import {act,cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DocumentExtractionDetail} from './DocumentExtractionDetail';
import type {HistoryDetail} from '@/lib/documents/history-store';
const initial={run:{id:'run',document_id:'doc',notice_key:'key',filename:'공고.pdf',document_type:'pdf',status:'processing',source:'manual',attempt_number:1,stage:'extracting',has_content:true,page_count:2,current_page:2,completed_pages:1,total_pages:2,requested_at:'2026-10-30T00:00:00Z',diagnostic_error:null},chain:[]} as unknown as HistoryDetail;
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('실행 진단만 제공하고 본문과 재추출은 파일 상세로 분리합니다',()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 render(<DocumentExtractionDetail initial={{...initial,run:{...initial.run,status:'completed'},requestState:{canRequest:true,reason:null,active:null}}}/>);
 expect(screen.getByText('텍스트 추출')).toBeInTheDocument();expect(screen.getByText('run')).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'← 파일 상세로 돌아가기'})).toHaveAttribute('href','/admin/document-extractions/files/doc');
 expect(screen.queryByRole('heading',{name:'추출 본문'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'재추출'})).not.toBeInTheDocument();
 expect(fetcher).not.toHaveBeenCalled();
});
it('5초마다 해당 실행의 진행을 확인하고 완료되면 폴링을 중단합니다',async()=>{
 vi.useFakeTimers();const fetcher=vi.fn(async()=>Response.json({...initial,run:{...initial.run,status:'completed'}}));vi.stubGlobal('fetch',fetcher);
 render(<DocumentExtractionDetail initial={initial}/>);
 await act(()=>vi.advanceTimersByTimeAsync(5000));expect(fetcher).toHaveBeenCalledTimes(1);
 await act(()=>vi.advanceTimersByTimeAsync(15000));expect(fetcher).toHaveBeenCalledTimes(1);
});
