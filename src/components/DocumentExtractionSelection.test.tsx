// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {DocumentFile} from '@/lib/documents/history-store';
import {DocumentExtractionSelection} from './DocumentExtractionSelection';
const {refresh}=vi.hoisted(()=>({refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
const docs=['a','b','c'].map(id=>({document_id:id,notice_key:'notice--001',filename:`${id}.pdf`,latest:null,
 requestState:{canRequest:id!=='c',reason:id==='c'?'지원하지 않는 파일':null,active:null}})) as DocumentFile[];
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
it('선택 요청 영역은 기본으로 닫히고 체크박스는 카드 제목 앞에 있습니다',()=>{
 const {container}=render(<DocumentExtractionSelection documents={docs} scopeKey="page=1">{docs.map(d=><div key={d.document_id}>문서 정보</div>)}</DocumentExtractionSelection>);
 const accordion=screen.getByText('선택 문서 추출').closest('details')!;
 expect(accordion).not.toHaveAttribute('open');
 const checkbox=screen.getByRole('checkbox',{name:'a.pdf 선택'});
 expect(checkbox.closest('article')).toHaveClass('extraction-card');
 expect(checkbox.closest('h2')).toHaveTextContent('a.pdf');
 expect(container.querySelector('h2')?.firstElementChild).toBe(checkbox);
});
it('현재 페이지에서 가능한 문서만 선택하고 일부 실패 뒤에도 나머지를 접수합니다',async()=>{
 const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('/a/')?Response.json({error:'접수 실패'},{status:503}):Response.json({id:'run-b',awake:false},{status:200}));
 vi.stubGlobal('fetch',fetcher);
 render(<DocumentExtractionSelection documents={docs} scopeKey="page=1">{docs.map(doc=><article key={doc.document_id}>{doc.filename}</article>)}</DocumentExtractionSelection>);
 expect(screen.getByRole('checkbox',{name:'c.pdf 선택'})).toBeDisabled();
 fireEvent.click(screen.getByText('선택 문서 추출'));fireEvent.click(screen.getByRole('checkbox',{name:'현재 페이지 전체 선택'}));
 fireEvent.click(screen.getByRole('button',{name:'선택 문서 추출 요청'}));
 await screen.findByRole('link',{name:'b.pdf 실행 확인'});
 expect(fetcher).toHaveBeenCalledTimes(2);expect(screen.getByText(/신규 접수 0건 · 기존 요청 1건 · 실패 1건/)).toBeInTheDocument();
 expect(screen.getByRole('checkbox',{name:'a.pdf 선택'})).toBeChecked();
 expect(screen.getByRole('checkbox',{name:'b.pdf 선택'})).not.toBeChecked();
 await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(1));
});
it('검색 조건이나 페이지 변경 시 선택을 초기화합니다',()=>{
 const {rerender}=render(<DocumentExtractionSelection documents={docs} scopeKey="page=1">{docs.map(d=><article key={d.document_id}>{d.filename}</article>)}</DocumentExtractionSelection>);
 fireEvent.click(screen.getByRole('checkbox',{name:'a.pdf 선택'}));
 rerender(<DocumentExtractionSelection documents={docs} scopeKey="page=2">{docs.map(d=><article key={d.document_id}>{d.filename}</article>)}</DocumentExtractionSelection>);
 expect(screen.getByRole('checkbox',{name:'a.pdf 선택'})).not.toBeChecked();
});

it('실패 문서만 재요청하고 이전 성공 결과와 중복 차단을 유지합니다',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({error:'일시 실패'},{status:503}))
  .mockResolvedValueOnce(Response.json({id:'run-b',awake:true},{status:202}))
  .mockResolvedValueOnce(Response.json({id:'run-a',awake:true},{status:202}));
 vi.stubGlobal('fetch',fetcher);
 render(<DocumentExtractionSelection documents={docs} scopeKey="page=1">{docs.map(d=><article key={d.document_id}>{d.filename}</article>)}</DocumentExtractionSelection>);
 fireEvent.click(screen.getByText('선택 문서 추출'));fireEvent.click(screen.getByRole('checkbox',{name:'현재 페이지 전체 선택'}));fireEvent.click(screen.getByRole('button',{name:'선택 문서 추출 요청'}));
 await screen.findByRole('link',{name:'b.pdf 실행 확인'});
 fireEvent.click(screen.getByRole('button',{name:'선택 문서 추출 요청'}));
 await screen.findByRole('link',{name:'a.pdf 실행 확인'});
 expect(screen.getByRole('link',{name:'b.pdf 실행 확인'})).toBeInTheDocument();
 expect(fetcher).toHaveBeenCalledTimes(3);expect(fetcher.mock.calls[2][0]).toContain('/a/extractions');
 expect(screen.getByRole('checkbox',{name:'b.pdf 선택'})).toBeDisabled();
});

it('접수 중 중복 클릭을 막고 화면을 떠나면 다음 문서는 접수하지 않습니다',async()=>{
 let resolve!:(response:Response)=>void;
 const fetcher=vi.fn((_input:RequestInfo|URL,_init?:RequestInit)=>new Promise<Response>(done=>{resolve=done;}));vi.stubGlobal('fetch',fetcher);
 const {unmount}=render(<DocumentExtractionSelection documents={docs} scopeKey="page=1">{docs.map(d=><article key={d.document_id}>{d.filename}</article>)}</DocumentExtractionSelection>);
 fireEvent.click(screen.getByText('선택 문서 추출'));fireEvent.click(screen.getByRole('checkbox',{name:'현재 페이지 전체 선택'}));
 const button=screen.getByRole('button',{name:'선택 문서 추출 요청'});fireEvent.click(button);fireEvent.click(button);
 expect(fetcher).toHaveBeenCalledTimes(1);expect(button).toBeDisabled();
 unmount();expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
 resolve(Response.json({id:'run-a',awake:true},{status:202}));
 await new Promise(done=>setTimeout(done,0));expect(fetcher).toHaveBeenCalledTimes(1);expect(refresh).not.toHaveBeenCalled();
});
