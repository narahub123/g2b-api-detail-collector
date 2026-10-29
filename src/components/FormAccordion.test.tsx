// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormAccordion } from "./FormAccordion";

afterEach(cleanup);

describe("FormAccordion", () => {
  it("기본적으로 닫히고 summary를 클릭하면 열리고 닫힙니다", () => {
    render(<FormAccordion title="검증 섹션"><p>내용</p></FormAccordion>);
    const summary = screen.getByText("검증 섹션").closest("summary")!;
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).not.toHaveAttribute("open");
  });

  it("defaultOpen과 사용자 정의 className을 적용합니다", () => {
    render(<FormAccordion title="처음 열린 섹션" defaultOpen className="custom-section">내용</FormAccordion>);
    const details = screen.getByText("처음 열린 섹션").closest("details")!;
    expect(details).toHaveAttribute("open");
    expect(details).toHaveClass("custom-section");
  });
  it("열림 변경을 알리면서 자식 상태를 마운트한 채 유지합니다",()=>{
    const changes:boolean[]=[];
    render(<FormAccordion title="상태 알림" onOpenChange={open=>changes.push(open)}><input aria-label="보존 값" defaultValue="유지"/></FormAccordion>);
    const details=screen.getByText('상태 알림').closest('details')!;
    details.open=true;fireEvent(details,new Event('toggle'));details.open=false;fireEvent(details,new Event('toggle'));
    expect(changes).toEqual([true,false]);expect(screen.getByLabelText('보존 값')).toHaveValue('유지');
  });
});
