// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {ManualExtractionAction} from './ManualExtractionAction';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('재추출을 접수하고 작업기 안내와 새 실행 링크를 제공합니다',async()=>{
 const fetcher=vi.fn(async()=>Response.json({id:'new-run',awake:false},{status:202}));vi.stubGlobal('fetch',fetcher);
 render(<ManualExtractionAction noticeKey="notice--001" documentId="doc" state={{canRequest:true,reason:null,active:null}}/>);
 fireEvent.click(screen.getByRole('button',{name:'재추출'}));
 expect(await screen.findByRole('link',{name:'접수한 실행 확인'})).toHaveAttribute('href','/admin/document-extractions/new-run');
 expect(screen.getByText(/작업기에 연결하지 못했지만/)).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'재추출'})).toBeDisabled();
});
it('다른 체인의 활성 요청이 있으면 새 요청 대신 기존 실행을 안내합니다',()=>{
 render(<ManualExtractionAction noticeKey="notice--001" documentId="doc" state={{canRequest:false,reason:'이미 요청 중입니다.',active:{id:'active-run',status:'queued'}}}/>);
 expect(screen.getByRole('link',{name:'진행 중인 실행 확인'})).toHaveAttribute('href','/admin/document-extractions/active-run');
 expect(screen.getByRole('button',{name:'재추출'})).toBeDisabled();
});

it('접수 실패를 안내하고 다시 요청할 수 있습니다',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:'일시적인 오류'},{status:503})).mockResolvedValueOnce(Response.json({id:'retry',awake:true},{status:202}));
 vi.stubGlobal('fetch',fetcher);
 render(<ManualExtractionAction noticeKey="notice--001" documentId="doc" state={{canRequest:true,reason:null,active:null}}/>);
 fireEvent.click(screen.getByRole('button',{name:'재추출'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('일시적인 오류');
 fireEvent.click(screen.getByRole('button',{name:'재추출'}));
 expect(await screen.findByRole('link',{name:'접수한 실행 확인'})).toHaveAttribute('href','/admin/document-extractions/retry');
});

it('접수 중 연속 클릭을 막고 화면을 떠나면 응답 반영을 중단합니다',()=>{
 const fetcher=vi.fn<typeof fetch>(()=>new Promise(()=>{}));vi.stubGlobal('fetch',fetcher);
 const {unmount}=render(<ManualExtractionAction noticeKey="notice--001" documentId="doc" state={{canRequest:true,reason:null,active:null}}/>);
 fireEvent.click(screen.getByRole('button',{name:'재추출'}));fireEvent.click(screen.getByRole('button',{name:'접수 중…'}));
 expect(fetcher).toHaveBeenCalledTimes(1);unmount();expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
