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
