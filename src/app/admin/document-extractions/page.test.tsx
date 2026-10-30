import {beforeEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
const {list,listDocuments,types,detail,overview}=vi.hoisted(()=>({list:vi.fn(),listDocuments:vi.fn(),types:vi.fn(async()=>['pdf']),detail:vi.fn(),overview:vi.fn()}));
vi.mock('@/lib/documents/overview-store',()=>({DocumentOverviewStore:class{overview=overview;}}));
vi.mock('@/lib/documents/history-store',async original=>({...await original<object>(),DocumentHistoryStore:class{list=list;listDocuments=listDocuments;types=types;detail=detail;}}));
vi.mock('@/lib/documents/page-access',()=>({guardDocumentPage:vi.fn()}));
vi.mock('@/lib/documents/pool',()=>({getDocumentPool:vi.fn()}));
import Page from './page';
it('미요청 파일은 실행 상세 링크 없이 공고와 등록 정보를 표시합니다',async()=>{
 listDocuments.mockResolvedValue({items:[{document_id:'doc',notice_key:'notice',filename:'미요청.hwp',document_type:'hwp',created_at:'2026-10-30T00:00:00Z',latest:null}],totalCount:1,totalPages:1,page:1,hasNext:false});
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({view:'documents',status:'unrequested'})}));
 expect(html).toContain('파일별 최신 상태');expect(html).toContain('미요청.hwp');expect(html).toContain('추출 요청 이력이 없습니다.');
 expect(html).not.toContain('/document-extractions/null');expect(html).toContain('name="view" value="documents"');
});
it('파일별 보기의 검색과 페이지 이동은 조회 기준·유형·상태를 유지합니다',async()=>{
 listDocuments.mockResolvedValue({items:[],totalCount:41,totalPages:3,page:1,hasNext:true});
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({view:'documents',type:'__unknown__',status:'unrequested',filename:'자료'})}));
 expect(html).toContain('value="__unknown__" selected=""');expect(html).toContain('value="unrequested" selected=""');
 expect(html).toContain('view=documents&amp;type=__unknown__&amp;status=unrequested&amp;filename=%EC%9E%90%EB%A3%8C&amp;page=2');
 expect(html).toContain('파일별 최신 상태');expect(html).toContain('전체 추출 시도 이력 보기');
});
beforeEach(()=>{list.mockResolvedValue({items:[],hasNext:false,page:1,totalCount:0,totalPages:1});overview.mockResolvedValue({generatedAt:'2026-10-30T00:00:00Z',totals:{total:7,unrequested:7,queued:0,processing:0,completed:0,no_text:0,failed:0,interrupted:0,unsupported:0},byType:[],workflow:{totals:{queued:0,ready:0,scheduled:0,processing:0,stages:{attachment:0,download:0,opening:0,extracting:0,saving:0,unknown:0}},byType:[],processing:[]}});});
it('이력 검색과 독립된 전체 현황을 목록 위에 표시합니다',async()=>{
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({status:'failed',type:'pdf',page:'3'})}));
 expect(html).toContain('전체 누적 현황');expect(html).toContain('등록 파일');expect(html.indexOf('전체 누적 현황')).toBeLessThan(html.indexOf('extraction-filters'));
 expect(overview).toHaveBeenCalledWith();
});
it('현황 조회만 실패해도 이력과 재조회 가능한 오류 안내를 유지합니다',async()=>{
 overview.mockRejectedValue(new Error('secret'));
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
 expect(html).toContain('문서 추출 현황을 조회하지 못했습니다');expect(html).toContain('저장된 추출 이력이 없습니다.');expect(html).not.toContain('secret');
});
it('문서 공통 필터와 빈 이력 안내를 표시합니다',async()=>{
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}));
 expect(html).toContain('첨부파일 추출 이력');expect(html).toContain('저장된 추출 이력이 없습니다.');expect(html).toContain('문서 형식');
});
it('DB 오류와 잘못된 필터를 사용자 안내로 표시합니다',async()=>{
 list.mockRejectedValue(new Error('secret'));
 expect(renderToStaticMarkup(await Page({searchParams:Promise.resolve({})}))).not.toContain('secret');
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({from:'bad'})}));expect(html).toContain('접수일을 확인하세요.');
});
it('공통 페이지네이션으로 이동하면서 추출 검색 조건을 유지합니다',async()=>{
 list.mockResolvedValue({items:[],hasNext:true,page:1,totalCount:41,totalPages:3});
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({status:'failed',type:'pdf'})}));
 expect(html).toContain('class="notice-pagination"');expect(html).toContain('/admin/document-extractions?status=failed&amp;type=pdf&amp;page=2');
 expect(html).toContain('href="/admin/document-extractions?status=failed&amp;type=pdf&amp;page=3">마지막으로');
});
