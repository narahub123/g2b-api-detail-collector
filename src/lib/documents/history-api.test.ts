import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHistoryApi} from './history-api';
const store={list:vi.fn(),detail:vi.fn(),types:vi.fn()};
const api=createHistoryApi(store as never);
beforeEach(()=>{vi.stubEnv('PDF_EXTRACTION_ENABLED','true');vi.stubEnv('NODE_ENV','development');});
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it('접근 제한과 잘못된 ID는 DB 조회 전에 거부합니다',async()=>{
 expect((await api(new Request('http://external.test/api/admin/document-extractions'))).status).toBe(403);
 expect((await api(new Request('http://localhost:3000/api/admin/document-extractions'),'invalid')).status).toBe(404);
 expect(store.detail).not.toHaveBeenCalled();expect(store.list).not.toHaveBeenCalled();
});
it('응답은 캐시하지 않고 DB 오류는 일반 안내로 표시합니다',async()=>{
 store.list.mockRejectedValue(new Error('postgres://secret'));
 const result=await api(new Request('http://localhost:3000/api/admin/document-extractions'));
 expect(result.status).toBe(503);expect(result.headers.get('cache-control')).toBe('no-store');expect(await result.text()).not.toContain('secret');
});
