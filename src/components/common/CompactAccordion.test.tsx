// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CompactAccordion } from "./CompactAccordion";

afterEach(cleanup);

describe("CompactAccordion", () => {
  it("기본적으로 접힌 상태이고 왼쪽 화살표를 위한 기본 summary 구조를 사용합니다", () => {
    render(
      <CompactAccordion title="세부 작업 시간">
        <p>집계 결과</p>
      </CompactAccordion>,
    );
    const summary = screen.getByText("세부 작업 시간");
    const details = summary.closest("details");
    expect(summary.tagName).toBe("SUMMARY");
    expect(details).toHaveClass("compact-accordion");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("집계 결과")).toBeInTheDocument();
  });

  it("summary 클릭으로 열고 닫을 수 있습니다", () => {
    render(
      <CompactAccordion title="다운로드 세부 시간">내역</CompactAccordion>,
    );
    const summary = screen.getByText("다운로드 세부 시간");
    const details = summary.closest("details")!;
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).not.toHaveAttribute("open");
  });

  it("초기 열림과 추가 클래스가 적용됩니다", () => {
    render(
      <CompactAccordion title="열린 항목" defaultOpen className="extra">
        내용
      </CompactAccordion>,
    );
    const details = screen.getByText("열린 항목").closest("details");
    expect(details).toHaveAttribute("open");
    expect(details).toHaveClass("compact-accordion", "extra");
  });

  it("표 안에서 세부 집계 테이블을 그대로 렌더링합니다", () => {
    render(
      <table>
        <tbody>
          <tr>
            <td>
              <CompactAccordion title="세부 작업 시간">
                <table aria-label="세부 작업 시간 집계">
                  <tbody>
                    <tr>
                      <td>모달 확인</td>
                    </tr>
                  </tbody>
                </table>
              </CompactAccordion>
            </td>
          </tr>
        </tbody>
      </table>,
    );
    expect(
      screen.getByRole("table", { name: "세부 작업 시간 집계" }),
    ).toBeInTheDocument();
    expect(screen.getByText("모달 확인")).toBeInTheDocument();
  });
});
