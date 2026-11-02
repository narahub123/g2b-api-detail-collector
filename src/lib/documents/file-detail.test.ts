import {testAttachment} from './test-attachments';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DocumentHistoryStore,parseHistoryFilters} from './history-store';
import {createFileDetailApi} from './file-detail-api';
const id='12345678-1234-1234-1234-123456789012',key='R26BK01797756--001';
beforeEach(()=>{vi.stubEnv('PDF_EXTRACTION_ENABLED','true');vi.stubEnv('NODE_ENV','development');});
afterEach(()=>vi.unstubAllEnvs());
it('기본 조회는 파일 단위이며 전체 실행 조회는 명시적으로 선택합니다',()=>{
 expect(parseHistoryFilters(new URLSearchParams()).view).toBe('documents');
 expect(parseHistoryFilters(new URLSearchParams('view=history')).view).toBe('history');
});
it('최신 실패와 현재 성공 본문을 독립적으로 반환하며 원문이나 내부 식별자를 노출하지 않습니다',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{id,notice_key:key,filename:'자료.pdf',document_type:'pdf',attachment_url:'url',file_no:id,seq:1,
  attachments:[testAttachment(key,id,1)],latest:{id:'failed',status:'failed'},content:{run_id:'success',page_count:2,finished_at:'2026-11-02T00:00:00Z'},active:null}]});
 const result=await new DocumentHistoryStore({query} as never).file(id);
 expect(result).toMatchObject({latest:{status:'failed'},content:{run_id:'success'},requestState:{canRequest:true}});
 expect(JSON.stringify(result)).not.toMatch(/attachments|file_no/);
 expect(query.mock.calls[0][0]).not.toMatch(/INSERT|UPDATE|DELETE/);
 expect(query.mock.calls[0][0]).toContain('s.document_id=d.id');
});
it('파일 API는 미요청 파일을 반환하고 접근 제한과 잘못된 ID를 먼저 검사합니다',async()=>{
 const file=vi.fn().mockResolvedValue({id,latest:null,content:null});const api=createFileDetailApi({file} as never);
 const response=await api(new Request('http://localhost/api/admin/document-extractions/files/'+id),id);
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toMatchObject({id,latest:null});
 file.mockClear();expect((await api(new Request('http://localhost/files/invalid'),'invalid')).status).toBe(404);
 expect((await api(new Request('http://external.test/files/'+id),id)).status).toBe(403);expect(file).not.toHaveBeenCalled();
 file.mockResolvedValue(null);expect((await api(new Request('http://localhost/files/'+id),id)).status).toBe(404);
});
