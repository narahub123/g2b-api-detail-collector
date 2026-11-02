import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { getCollectionJob } = vi.hoisted(() => ({ getCollectionJob: vi.fn() }));
vi.mock("@/lib/g2b/collection-job", () => ({ getCollectionJob }));
import CollectionJobPage from "./page";

it("진단 분류를 기준으로 건수를 표시하고 개별 기록을 필터링합니다", async () => {
  getCollectionJob.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", status: "completed", errors: ["기존 오류"],
    diagnostics: { events: [
      { at: "2026-10-28T00:00:00Z", severity: "failure", stage: "api", operation: "fetch-page", target: { pageNo: 2 }, error: { name: "Error", message: "API 실패" } },
      { at: "2026-10-28T00:00:01Z", severity: "warning", stage: "modal", operation: "collect-modal", target: { key: "R26BK1--000" }, error: { name: "Error", message: "모달 경고" } }
    ], overflowCount: 0, types: {
      a: { count: 1, representative: { severity: "failure" } }, b: { count: 1, representative: { severity: "warning" } }
    } } });
  const html = renderToStaticMarkup(await CollectionJobPage({ params: Promise.resolve({ jobId: "11111111-1111-4111-8111-111111111111" }),
    searchParams: Promise.resolve({ severity: "warning" }) }));
  expect(html).toContain("실패 1건 · 경고 1건");
  expect(html).toContain("모달 경고");
  expect(html).not.toContain("API 실패");
  expect(html).not.toContain("기존 오류");
  expect(html).toContain("수집 처리 관측");
  expect(html.indexOf("수집 처리 관측")).toBeLessThan(html.indexOf("필터 적용"));
});

it('원인 JSON은 접힌 상세로 제공하고 과거 요약에는 미기록을 표시합니다',async()=>{
 const entry={at:'2026-10-28T00:00:00Z',severity:'failure',stage:'detail',operation:'scrape-detail',error:{name:'Error',message:'failed'},diagnostic:{message:'failed',stack:'Error: failed\n at parser.ts:42:1',cause:{code:'ECONNRESET'},errors:[{code:'ETIMEDOUT'}],extra:{status:502}}};
 getCollectionJob.mockResolvedValue({id:'job',status:'completed',errors:[],diagnostics:{events:[entry,{...entry,diagnostic:undefined}],overflowCount:1,types:{failure:{count:501,firstAt:entry.at,lastAt:entry.at,representative:entry}}}});
 const html=renderToStaticMarkup(await CollectionJobPage({params:Promise.resolve({jobId:'job'})}));
 expect(html).toContain('<summary>기술 정보 펼쳐보기</summary>');
 expect(html).toContain('ECONNRESET');expect(html).toContain('ETIMEDOUT');expect(html).toContain('parser.ts:42:1');
 expect(html).toContain('원인 진단 미기록');expect(html).toContain('개별 목록 초과 1건');
 expect(html.match(/<summary>기술 정보 펼쳐보기<\/summary>/g)).toHaveLength(2);
 expect(html).not.toContain('<details open');
});
it('이전 작업의 메시지만 남아 있어도 원인 부재를 단정하지 않습니다',async()=>{
 getCollectionJob.mockResolvedValue({id:'old',status:'failed',errors:['legacy failed']});
 const html=renderToStaticMarkup(await CollectionJobPage({params:Promise.resolve({jobId:'old'})}));
 expect(html).toContain('legacy failed');expect(html).toContain('원인 진단 미기록');
});
