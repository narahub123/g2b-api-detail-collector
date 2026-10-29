import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {createDocumentApi} from './api';
const id='12345678-1234-1234-1234-123456789012',key='R26BK01797756--001';
const store={list:vi.fn(),document:vi.fn(),history:vi.fn(),run:vi.fn(),page:vi.fn()};
const queue={enqueue:vi.fn()};const wake=vi.fn();
const api=createDocumentApi(store as never,queue as never,wake);
/** 로컬 관리자의 공고 소속 정보를 담은 요청을 만듭니다. */
function request(method='GET',suffix=''){return new Request(`http://localhost:3000/api/admin/documents?key=${key}${suffix}`,{method,headers:method==='POST'?{origin:'http://localhost:3000','content-type':'application/json'}:{},...(method==='POST'?{body:JSON.stringify({key})}:{})});}
beforeEach(()=>{vi.stubEnv('PDF_EXTRACTION_ENABLED','true');vi.stubEnv('NODE_ENV','development');store.document.mockResolvedValue({file_no:'file',seq:1});queue.enqueue.mockResolvedValue({id,reused:false});wake.mockResolvedValue({awake:false});});
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it('Docker 접속 실패여도 DB 요청을 보존하고 신규202·중복200을 반환합니다',async()=>{
 const response=await api(request('POST'),{documentId:id});expect(response.status).toBe(202);expect(await response.json()).toMatchObject({id,awake:false});
 queue.enqueue.mockResolvedValue({id,reused:true});expect((await api(request('POST'),{documentId:id})).status).toBe(200);
 expect(queue.enqueue).toHaveBeenCalledWith(key,'file',1,'manual');
});
it('로컬·활성화·출처 검사는 DB 접근보다 먼저 수행합니다',async()=>{
 vi.stubEnv('PDF_EXTRACTION_ENABLED','false');expect((await api(request())).status).toBe(404);
 vi.stubEnv('PDF_EXTRACTION_ENABLED','true');vi.stubEnv('NODE_ENV','production');expect((await api(request())).status).toBe(404);
 vi.stubEnv('NODE_ENV','development');expect((await api(new Request('http://external.test/api/admin/documents?key='+key))).status).toBe(403);
 expect((await api(new Request('http://localhost:3000/api/admin/documents?key='+key,{headers:{origin:'http://other.test'}}))).status).toBe(403);
 expect(store.list).not.toHaveBeenCalled();
});
it('문서·실행·공고 소속과 양수 페이지·이력 cursor를 확인합니다',async()=>{
 store.run.mockResolvedValue(null);expect((await api(request(),{documentId:id,runId:id})).status).toBe(404);
 expect(store.run).toHaveBeenCalledWith(key,id,id);
 expect((await api(request(),{documentId:id,runId:id,page:'0'})).status).toBe(400);
 expect((await api(request('GET','&cursor=invalid'),{documentId:id})).status).toBe(400);
});
it('저장소 오류·작업기 토큰을 노출하지 않고 모든 조회를 no-store로 반환합니다',async()=>{
 store.list.mockResolvedValue({documents:[],unsupported:[]});const result=await api(request());expect(result.headers.get('cache-control')).toBe('no-store');
 store.list.mockRejectedValue(new Error('postgres://secret'));expect(await(await api(request())).text()).not.toContain('secret');
});
it('JSON 기본값은 400으로 거부하고 깨우기 예외는 접수 결과를 바꾸지 않습니다',async()=>{
 for(const body of ['null','"string"','1'])expect((await api(new Request('http://localhost:3000/api/admin/documents',{method:'POST',body}),{documentId:id})).status).toBe(400);
 wake.mockRejectedValue(new Error('작업기 연결 오류'));
 expect((await api(request('POST'),{documentId:id})).status).toBe(202);
});
