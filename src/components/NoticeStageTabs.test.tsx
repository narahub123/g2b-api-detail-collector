// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoticeStageTabs } from "./NoticeStageTabs";

/** 기존 공고를 유지하면서 서버에서 전달된 단계별 내용을 표시하는지 확인합니다. */
describe("NoticeStageTabs", () => {
  afterEach(cleanup);

  it("공고를 기본 선택하고 기존 본문을 표시합니다", () => {
    render(<NoticeStageTabs plan={<div>발주계획 자료</div>} spec={<div>사전규격 자료</div>}>
      <div>기존 공고 상세 본문</div>
    </NoticeStageTabs>);
    expect(screen.getByRole("tab", { name: "공고" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "공고" })).toHaveTextContent("기존 공고 상세 본문");
  });

  it("발주계획과 사전규격으로 전환하면 전달된 데이터를 표시합니다", () => {
    render(<NoticeStageTabs plan={<div>발주계획 자료</div>} spec={<div>사전규격 자료</div>}>
      <div>기존 공고 상세 본문</div>
    </NoticeStageTabs>);
    fireEvent.click(screen.getByRole("tab", { name: "발주계획" }));
    expect(screen.getByRole("tabpanel", { name: "발주계획" })).toHaveTextContent("발주계획 자료");
    expect(document.getElementById("notice-panel-notice")).not.toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "사전규격" }));
    expect(screen.getByRole("tabpanel", { name: "사전규격" })).toHaveTextContent("사전규격 자료");
    fireEvent.click(screen.getByRole("tab", { name: "공고" }));
    expect(screen.getByRole("tabpanel", { name: "공고" })).toHaveTextContent("기존 공고 상세 본문");
  });

  it("연결하지 않은 개찰·낙찰자·계약 탭은 기존 안내를 유지합니다", () => {
    render(<NoticeStageTabs plan={<div>발주계획 자료</div>} spec={<div>사전규격 자료</div>}>
      <div>공고 본문</div>
    </NoticeStageTabs>);
    for (const name of ["개찰", "낙찰자", "계약"]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(screen.getByRole("tabpanel", { name })).toHaveTextContent("다음 데이터 연결 작업");
    }
  });

  it("별도 내용이 전달되지 않으면 기존 안내를 유지합니다", () => {
    render(<NoticeStageTabs><div>공고 본문</div></NoticeStageTabs>);
    for (const name of ["발주계획", "사전규격"]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(screen.getByRole("tabpanel", { name })).toHaveTextContent("다음 데이터 연결 작업");
    }
  });
});
