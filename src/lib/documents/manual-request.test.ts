import {afterEach,expect,it,vi} from 'vitest';
import {requestManualExtraction} from './manual-request';

afterEach(()=>vi.unstubAllGlobals());
it.each([200,202])('접수 상태 %i와 작업기 연결 결과를 보존합니다',async status=>{
 const fetcher=vi.fn<typeof fetch>(async()=>Response.json({id:'run',awake:false},{status}));vi.stubGlobal('fetch',fetcher);
 expect(await requestManualExtraction('notice--001','doc')).toEqual({id:'run',awake:false,reused:status===200});
 expect(fetcher.mock.calls[0][0]).toBe('/api/admin/documents/doc/extractions?key=notice--001');
 expect(fetcher.mock.calls[0][1]).toMatchObject({method:'POST',cache:'no-store',body:JSON.stringify({key:'notice--001'})});
});
it('접수 실패의 서버 안내를 전달합니다',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'첨부가 없습니다.'},{status:404})));
 await expect(requestManualExtraction('notice--001','doc')).rejects.toThrow('첨부가 없습니다.');
});
