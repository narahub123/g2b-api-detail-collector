import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createOverviewApi} from './overview-api';
const store={overview:vi.fn()};
const api=createOverviewApi(store);
beforeEach(()=>{vi.stubEnv('PDF_EXTRACTION_ENABLED','true');vi.stubEnv('NODE_ENV','development');});
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
it('접근 제한과 조회 전용 정책을 DB 호출 전에 적용합니다',async()=>{
 expect((await api(new Request('http://external.test/api/admin/document-extractions/overview'))).status).toBe(403);
 expect((await api(new Request('http://localhost/api/admin/document-extractions/overview',{method:'POST'}))).status).toBe(405);
 vi.stubEnv('PDF_EXTRACTION_ENABLED','false');
 expect((await api(new Request('http://localhost/api/admin/document-extractions/overview'))).status).toBe(404);
 expect(store.overview).not.toHaveBeenCalled();
});
it('현황은 캐시하지 않고 내부 DB 오류를 노출하지 않습니다',async()=>{
 store.overview.mockResolvedValue({generatedAt:'now',totals:{total:0}});
 const result=await api(new Request('http://localhost/api/admin/document-extractions/overview'));
 expect(result.headers.get('cache-control')).toBe('no-store');expect(await result.json()).toMatchObject({totals:{total:0}});
 store.overview.mockRejectedValue(new Error('postgres://secret'));
 const failed=await api(new Request('http://localhost/api/admin/document-extractions/overview'));
 expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('secret');
});
