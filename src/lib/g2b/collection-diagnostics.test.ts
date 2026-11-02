import { expect, it } from "vitest";
import { addDiagnostic, diagnosticCounts, type DiagnosticState } from "./collection-diagnostics";

it("수집 오류의 단계와 대상을 보존합니다", () => {
  const state: DiagnosticState = {};
  addDiagnostic(state, { severity: "failure", stage: "api", operation: "fetch-page", error: new Error("fetch failed"), target: { pageNo: 2 } });
  expect(state.diagnostics?.events[0]).toMatchObject({ stage: "api", target: { pageNo: 2 } });
  expect(diagnosticCounts(state).failure).toBe(1);
});

it("500건 이후에도 새 오류 유형의 대표 기록과 건수를 남깁니다", () => {
  const state: DiagnosticState = {};
  for (let n = 0; n < 501; n++) addDiagnostic(state, { severity: "failure", stage: "api", operation: "fetch-page", error: new Error(`반복 ${n} 오류`) });
  addDiagnostic(state, { severity: "warning", stage: "modal", operation: "capture", error: new Error("새 유형") });
  expect(state.diagnostics?.events).toHaveLength(500);
  expect(state.diagnostics?.overflowCount).toBe(2);
  expect(Object.values(state.diagnostics?.types || {}).map((type) => type.count).sort((a, b) => a - b)).toEqual([1, 501]);
  expect(diagnosticCounts(state)).toEqual({ failure: 501, warning: 1, retry: 0 });
});

it("비밀값과 URL 쿼리의 인증값을 제거합니다", () => {
  const state: DiagnosticState = {};
  process.env.G2B_SERVICE_KEY = "test-secret";
  addDiagnostic(state, { severity: "failure", stage: "api", operation: "fetch", error: new Error("https://host/x?serviceKey=test-secret postgres://user:pass@host/db") });
  expect(JSON.stringify(state)).not.toContain("test-secret");
  expect(JSON.stringify(state)).not.toContain("pass@host");
  delete process.env.G2B_SERVICE_KEY;
});

it('요약 외에도 원인 객체를 보존하며 한도 이후 대표 진단에도 남깁니다',()=>{
 const state:DiagnosticState={};
 for(let i=0;i<500;i++)addDiagnostic(state,{severity:'warning',stage:'api',operation:'repeat',error:'repeat'});
 const entry=addDiagnostic(state,{severity:'failure',stage:'detail',operation:'scrape-detail',error:{message:'failed',cause:{code:'ECONNRESET',status:502},errors:[{code:'ETIMEDOUT'}],token:'hidden-value'}});
 expect(entry).toMatchObject({diagnostic:{cause:{code:'ECONNRESET',status:502},errors:[{code:'ETIMEDOUT'}]}});
 expect(JSON.stringify(state)).not.toContain('hidden-value');
 expect(Object.values(state.diagnostics!.types).some(type=>(type.representative as typeof entry).diagnostic===entry.diagnostic)).toBe(true);
 expect(state.diagnostics?.overflowCount).toBe(1);
});
