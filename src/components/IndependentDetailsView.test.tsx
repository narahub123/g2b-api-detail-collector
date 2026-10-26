// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IndependentReference } from "@/lib/g2b/notices";

vi.mock("./NoticeUserView", () => ({
  NoticeUserView: ({ detail }: { detail: { sections?: { title: string; fields: { label: string; value: { text: string; visible: boolean }[] }[] }[] } }) => (
    <div data-testid="stored-detail">
      {detail.sections?.map((section) => (
        <div key={section.title}>
          <h3>{section.title}</h3>
          {section.fields.map((field) => <p key={field.label}>{field.label}: {field.value.map((part) => part.text).join("")}</p>)}
        </div>
      ))}
    </div>
  ),
}));

import { IndependentDetailsView } from "./IndependentDetailsView";

/** 저장된 독립 상세의 표시와 미저장 상태를 확인합니다. */
describe("IndependentDetailsView", () => {
  afterEach(cleanup);

  it("참조가 없으면 저장된 상세 정보가 없음을 알립니다", () => {
    render(<IndependentDetailsView references={[]} />);
    expect(screen.getByText("저장된 상세 정보가 없습니다.")).toBeInTheDocument();
  });

  it("저장된 발주계획·사전규격 상세의 제목과 필드를 표시합니다", () => {
    const references: IndependentReference[] = [{
      number: "R26DD12345678",
      detail: {
        schemaVersion: 2,
        number: "R26DD12345678",
        title: "발주계획 상세",
        fields: [{ label: "사업명", value: [{ text: "테스트 사업", visible: true }] }],
        tables: [],
        capturedAt: "2026-10-25T00:00:00.000Z",
        sourceNoticeKey: "R26BK01774553--000",
      },
    }];
    render(<IndependentDetailsView references={references} />);
    expect(screen.getByRole("heading", { name: "발주계획 상세" })).toBeInTheDocument();
    expect(screen.getByText("사업명: 테스트 사업")).toBeInTheDocument();
  });

  it("새 독립 상세의 섹션을 그대로 표시합니다", () => {
    render(<IndependentDetailsView references={[{ number: "R26DD12345678", detail: {
      schemaVersion: 4, number: "R26DD12345678", title: "발주계획 상세", sections: [
        { title: "계약정보", fields: [{ label: "계약방법", value: [{ text: "일반경쟁", visible: true }] }], tables: [] },
        { title: "담당자정보", fields: [{ label: "담당자", value: [{ text: "홍길동", visible: true }] }], tables: [] }
      ], capturedAt: "2026-10-25T00:00:00.000Z", sourceNoticeKey: "R26BK01774553--000"
    } }]} />);
    expect(screen.getByRole("heading", { name: "계약정보" })).toBeInTheDocument();
    expect(screen.getByText("담당자: 홍길동")).toBeInTheDocument();
  });

  it("저장되지 않은 참조는 번호와 안내 문구를 표시합니다", () => {
    render(<IndependentDetailsView references={[{ number: "R26BD12345678", detail: null }]} />);
    expect(screen.getByText("R26BD12345678: 저장된 상세 정보가 없습니다.")).toBeInTheDocument();
  });

  it("이전 형식의 독립 상세는 렌더링하지 않고 재수집을 안내합니다", () => {
    const references = [{ number: "R26DD20902687", detail: {
      schemaVersion: 1, number: "R26DD20902687", title: "발주계획 상세",
      fields: [{ label: "사업명", value: "이전 값" }], tables: []
    } }] as unknown as IndependentReference[];
    render(<IndependentDetailsView references={references} />);
    expect(screen.getByText(/다시 수집/)).toBeInTheDocument();
    expect(screen.queryByTestId("stored-detail")).not.toBeInTheDocument();
  });

  it("연결된 공고는 상세 링크를 표시합니다", () => {
    render(<IndependentDetailsView references={[{
      number: "R26BK01774553-001",
      detail: null,
      noticeKey: "R26BK01774553--001",
    }]} />);
    expect(screen.getByRole("link", { name: "R26BK01774553-001 공고 상세 보기" }))
      .toHaveAttribute("href", "/bids/R26BK01774553--001/view");
  });
});
