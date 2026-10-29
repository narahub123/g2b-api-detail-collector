import { describe, expect, it } from "vitest";
import { readingOrderText, pathRectangles } from "./reading-order";

/** 상단 기준 좌표의 텍스트 항목을 실제 PDF.js 형태로 구성합니다. */
function item(str: string, x: number, top: number, width = str.length * 5) {
  return { str, width, height: 10, transform: [10, 0, 0, 10, x, 600 - top - 10], hasEOL: true };
}
const viewport = [1, 0, 0, -1, 0, 600];

describe("PDF 좌표 기반 읽기 순서", () => {
  it("본문 뒤에 기록된 표를 제목과 다음 항목 사이로 옮기고 두 단을 섞지 않습니다", () => {
    const items = [item("1. 견적에 부치는 사항", 40, 100), item("2. 전자견적 개시일시", 40, 300),
      item("3. 전자견적 마감일시", 40, 330), item("4. 개찰일시", 40, 360), item("5. 입찰참가 자격", 40, 400),
      item("용역명", 45, 140), item("평산도시계획도로", 110, 140), item("사업량", 45, 205),
      item("폐콘크리트 614톤", 110, 180), item("폐아스콘 89톤", 110, 210),
      item("다. 본 용역은 전자입찰", 460, 50), item("6. 입찰보증금", 460, 110),
      item("7. 입찰방법", 460, 150), item("8. 입찰서 제출", 460, 190), item("9. 낙찰자 결정", 460, 240)];
    const cells = [{ x: 40, y: 130, width: 60, height: 30 }, { x: 100, y: 130, width: 280, height: 30 },
      { x: 40, y: 160, width: 60, height: 100 }, { x: 100, y: 160, width: 280, height: 100 }];
    const text = readingOrderText(items, viewport, cells);
    expect(text.indexOf("1. 견적")).toBeLessThan(text.indexOf("용역명"));
    expect(text.indexOf("평산도시")).toBeLessThan(text.indexOf("2. 전자"));
    expect(text.indexOf("사업량")).toBeLessThan(text.indexOf("폐콘크리트"));
    expect(text.indexOf("폐아스콘")).toBeLessThan(text.indexOf("2. 전자"));
    expect(text.indexOf("5. 입찰")).toBeLessThan(text.indexOf("다. 본 용역"));
    for (const entry of items) expect(text).toContain(entry.str);
  });
  it("전폭 제목 아래에서 두 단을 구분하고 단일 본문은 행 순서로 읽습니다", () => {
    const text = readingOrderText([item("전폭 제목", 30, 10, 740), ...[0, 1, 2, 3].flatMap(i => [
      item(`왼쪽${i}`, 40, 80 + i * 20, 300), item(`오른쪽${i}`, 460, 80 + i * 20, 300)])], viewport);
    expect(text.indexOf("전폭 제목")).toBeLessThan(text.indexOf("왼쪽0"));
    expect(text.indexOf("왼쪽3")).toBeLessThan(text.indexOf("오른쪽0"));
    expect(readingOrderText([item("둘째 줄", 40, 50), item("첫째 줄", 40, 20)], viewport)).toBe("첫째 줄\n둘째 줄");
  });
  it("표의 셀 간격을 단 경계로 오인하지 않고 병합 셀을 먼저 읽습니다", () => {
    const cells = [
      { x: 20, y: 20, width: 200, height: 80 }, { x: 220, y: 20, width: 300, height: 80 },
      { x: 20, y: 100, width: 200, height: 40 }, { x: 220, y: 100, width: 300, height: 40 }];
    const text = readingOrderText([item("사업량", 30, 60), item("내용 첫줄", 240, 30), item("내용 둘째줄", 240, 60),
      item("기간", 30, 110), item("180일", 240, 110)], viewport, cells);
    expect(text.indexOf("사업량")).toBeLessThan(text.indexOf("내용 첫줄"));
    expect(text.indexOf("내용 둘째줄")).toBeLessThan(text.indexOf("기간"));
  });
  it("오른쪽 단이 왼쪽 단 하단에서 시작해도 단 분할을 줄 조립에서 유지합니다", () => {
    const text = readingOrderText([...[80, 110, 140].map((y, i) => item(`L${i}`, 40, y, 200)),
      ...[130, 160, 190].map((y, i) => item(`R${i}`, 460, y, 200))], viewport);
    expect(text).toBe("L0\nL1\nL2\nR0\nR1\nR2");
  });
  it("겹치는 글자와 문자 사이의 실제 간격을 보존합니다", () => {
    expect(readingOrderText([item("자", 10, 20, 10), item("격", 20, 20, 10), item("등록", 45, 20, 20)], viewport)).toBe("자격 등록");
    expect(readingOrderText([], viewport)).toBe("");
  });
  it("회전된 페이지도 표시 좌표로 변환합니다", () => {
    const rotated = [0, 1, 1, 0, 0, 0];
    const result = readingOrderText([
      { str: "둘째", width: 20, height: 10, transform: [0, 10, -10, 0, 80, 20] },
      { str: "첫째", width: 20, height: 10, transform: [0, 10, -10, 0, 40, 20] }], rotated);
    expect(result).toBe("첫째\n둘째");
  });
});

it("표 셀의 경로와 변환 행렬을 해석하며 밑줄과 곡선은 셀로 오인하지 않습니다", () => {
  const ops = { save: 10, restore: 11, transform: 12, constructPath: 91 };
  const rect = [0, 0, 0, 1, 60, 0, 1, 60, 30, 1, 0, 30, 4];
  const result = pathRectangles({ fnArray: [10, 12, 91, 11, 91], argsArray: [[], [1, 0, 0, 1, 20, 300],
    [28, [new Float32Array(rect)], null], [], [20, [new Float32Array([0, 0, 0, 1, 60, 0])], null]] }, viewport, ops);
  expect(result).toEqual([{ x: 20, y: 270, width: 60, height: 30 }]);
});

it("중첩 Form XObject의 표 셀 변환을 반영하고 종료 후 원래 좌표계를 복원합니다", () => {
  const ops = { save: 10, restore: 11, transform: 12, constructPath: 91, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75 };
  const rect = new Float32Array([0, 0, 0, 1, 60, 0, 1, 60, 30, 1, 0, 30, 4]);
  const result = pathRectangles({ fnArray: [74, 91, 75, 91], argsArray: [
    [[1, 0, 0, 1, 20, 300], null], [20, [rect], null], [], [20, [rect], null]] }, viewport, ops);
  expect(result).toEqual([{ x: 20, y: 270, width: 60, height: 30 }, { x: 0, y: 570, width: 60, height: 30 }]);
});
