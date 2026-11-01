import { expect, it } from "vitest";
import { assertNotMaintenance, G2bMaintenanceError, maintenanceFromError } from "./maintenance";

export const maintenanceHtml = '<html><title>시스템 점검 안내</title><h2>시스템점검안내</h2><p>현재 웹서비스가 중단되고 있음을 알려드립니다.</p><p>일정 : 2026년 01월 30일</p></html>';

it("명시적인 점검 안내만 감지하며 과거 일정도 무시하지 않습니다", () => {
  expect(() => assertNotMaintenance(maintenanceHtml, "api")).toThrow(G2bMaintenanceError);
  expect(() => assertNotMaintenance(maintenanceHtml.replace("시스템 점검 안내", "시스템\n 점검 안내"), "detail")).toThrow(G2bMaintenanceError);
  for (const text of ['<title>공지사항</title><p>시스템 점검 안내: 내일 점검 예정</p>', '<title>오류</title>', '{"message":"시스템 점검 안내"}'])
    expect(() => assertNotMaintenance(text, "api")).not.toThrow();
});

it("래핑된 점검 원인을 찾고 일반 오류는 보류하지 않습니다", () => {
  const error = new G2bMaintenanceError("download");
  expect(maintenanceFromError(new Error("페이지 오류", { cause: error }))).toEqual(error.maintenance);
  expect(maintenanceFromError(new Error("timeout"))).toBeNull();
});
