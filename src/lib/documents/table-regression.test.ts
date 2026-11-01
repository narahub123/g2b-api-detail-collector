import { describe, expect, it } from "vitest";
import fixture from "./fixtures/R26BK01800322-page1.json";
import { pathRectangles, readingOrderText } from "./reading-order";
import { EXTRACTOR_VERSION } from "./queue";

/** 공백 배치에 영향을 받지 않고 원문 글자의 누락과 중복을 비교합니다. */
function characters(text: string) {
  return [...text.replace(/\s/g, "")].sort().join("");
}

describe("R26BK01800322 실제 PDF 회귀", () => {
  it("배경과 개별 선으로 그린 표에서 항목과 값을 행 순서로 연결합니다", () => {
    const cells = pathRectangles(fixture.operations, fixture.viewport, fixture.ops);
    const text = readingOrderText(fixture.items, fixture.viewport, cells);
    const entries = ["건 명", "서울 디지털성범죄", "과 업 내 용", "붙임 ‘제안요청서’ 참조",
      "계 약 방 법", "제한경쟁입찰", "용 역 기 간", "2027.01.01", "사 업 비 용", "금199,000,000원",
      "입 찰 참 가 등 록", "나라장터 G2B 전자입찰", "2026년 10월 30일", "입찰참가자격등록은",
      "가격입찰서 등 제출", "직접방문제출", "2026년 11월 20일", "서울특별시 동작구", "점심시간",
      "입 찰 참 가 자 격", "아래 입찰참가자격 참조", "제안서 평가위원 회", "- 평가위원회"];
    let previous = -1;
    for (const entry of entries) {
      const index = text.indexOf(entry);
      expect(index, entry).toBeGreaterThan(previous);
      previous = index;
    }
    expect(text.match(/입 찰 참 가 등 록/g)).toHaveLength(1);
    expect(text.match(/가격입찰서 등 제출/g)).toHaveLength(1);
    expect(characters(text)).toBe(characters(fixture.items.map(item => item.str).join("")));
    expect(cells.some(cell => cell.x >= 239 && cell.width > 300)).toBe(true);
  });

  it("실행 요청이 실제 PDF 파서의 버전과 v2 읽기 순서를 사용합니다", () => {
    expect(EXTRACTOR_VERSION).toBe(`${fixture.pdfjsVersion} / reading-order-v2`);
  });
});
