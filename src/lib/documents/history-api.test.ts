import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHistoryApi} from './history-api';
const store={list:vi.fn(),listDocuments:vi.fn(),detail:vi.fn(),types:vi.fn()};
const api=createHistoryApi(store as never);
beforeEach(()=>{vi.stubEnv('PDF_EXTRACTION_ENABLED','true');vi.stubEnv('NODE_ENV','development');});
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it('기본 조회는 파일별 목록이며 전체 실행 이력은 명시적으로 선택합니다',async()=>{
 store.listDocuments.mockResolvedValue({items:[{document_id:'doc',latest:null}],totalCount:1});
 store.list.mockResolvedValue({items:[{id:'run'}],totalCount:1});
 const documents=await api(new Request('http://localhost/api/admin/document-extractions?status=unrequested'));
 expect(documents.status).toBe(200);expect(await documents.json()).toMatchObject({items:[{document_id:'doc',latest:null}]});
 const history=await api(new Request('http://localhost/api/admin/document-extractions?view=history'));
 expect(await history.json()).toMatchObject({items:[{id:'run'}]});
});
it('접근 제한과 잘못된 ID는 DB 조회 전에 거부합니다',async()=>{
 expect((await api(new Request('http://external.test/api/admin/document-extractions'))).status).toBe(403);
 expect((await api(new Request('http://localhost:3000/api/admin/document-extractions?view=history'),'invalid')).status).toBe(404);
 expect(store.detail).not.toHaveBeenCalled();expect(store.list).not.toHaveBeenCalled();
});
it('응답은 캐시하지 않고 DB 오류는 일반 안내로 표시합니다',async()=>{
 store.listDocuments.mockRejectedValue(new Error('postgres://secret'));
 const result=await api(new Request('http://localhost:3000/api/admin/document-extractions'));
 expect(result.status).toBe(503);expect(result.headers.get('cache-control')).toBe('no-store');expect(await result.text()).not.toContain('secret');
});
