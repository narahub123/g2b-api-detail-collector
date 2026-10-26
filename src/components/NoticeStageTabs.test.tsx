// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeStageTabs } from "./NoticeStageTabs";
import { NoticeUserView } from "./NoticeUserView";
import { IndependentDetailsView } from "./IndependentDetailsView";
import type { ScrapedDetail } from "@/lib/g2b/detail-page";

/** 기존 공고를 유지하면서 서버에서 전달된 단계별 내용을 표시하는지 확인합니다. */
describe("NoticeStageTabs", () => {
  beforeEach(() => { vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

  it("개찰 자료가 제공되면 개찰 탭에 표시합니다", () => {
    render(<NoticeStageTabs opening={<div>개찰 결과 자료</div>}><div>공고 본문</div></NoticeStageTabs>);
    fireEvent.click(screen.getByRole("tab", { name: "개찰" }));
    expect(screen.getByRole("tabpanel", { name: "개찰" })).toHaveTextContent("개찰 결과 자료");
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

  it("탭 버튼으로 전환하면 페이지 상단으로 스크롤합니다", () => {
    render(<NoticeStageTabs plan={<div>발주계획 자료</div>}><div>공고 본문</div></NoticeStageTabs>);
    fireEvent.click(screen.getByRole("tab", { name: "발주계획" }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" });
  });

  it("모든 탭 본문에서 확인된 번호만 연결하고 현재 탭 번호는 텍스트로 둡니다", () => {
    const targets = { currentKey: "R26BK01766517--001", relatedKeys: ["R26BK01766517--000"],
      planNumbers: ["R26DD20897516"], specNumbers: ["R26BD00283215"], opening: [] };
    const notice: ScrapedDetail = { sourceUrl: "", attachments: [], links: [], sections: [{
      title: "연관정보", fields: [
        { label: "발주계획번호", value: [{ text: "R26DD20897516", visible: true }] },
        { label: "사전규격등록번호", value: [{ text: "R26BD00283215", visible: true }] },
        { label: "관련공고", value: [{ text: "R26BK01766517-000R26BK01766517-001", visible: true }] },
      ], tables: [{ headerRows: [[{ value: "관련공고", column: 0, rowspan: 1, colspan: 1 }]],
        bodyRows: [[{ value: "R26BK01766517-000R26BK01766517-001", column: 0, rowspan: 1, colspan: 1 }]] }],
    }] };
    const planDetail = { schemaVersion: 5 as const, number: "R26DD20897516", title: "발주계획 상세",
      sections: [{ title: "계획", fields: [
        { label: "발주계획번호", value: [{ text: "R26DD20897516", visible: true }] },
        { label: "입찰공고번호", value: [{ text: "R26BK01766517-001", visible: true }] },
        { label: "사전규격등록번호", value: [{ text: "R26BD00283215", visible: true }] },
      ], tables: [] }], capturedAt: "2026-10-26T00:00:00Z", sourceNoticeKey: targets.currentKey };
    render(<NoticeStageTabs targets={targets}
      plan={<IndependentDetailsView references={[{ number: planDetail.number, detail: planDetail }]} />}
      spec={<div id="notice-reference-R26BD00283215" tabIndex={-1}><NoticeUserView detail={{
        sourceUrl: "", attachments: [], links: [], sections: [{ title: "규격", fields: [
          { label: "사전규격등록번호", value: [{ text: "R26BD00283215", visible: true }] },
          { label: "발주계획번호", value: [{ text: "R26DD20897516", visible: true }] },
        ], tables: [] }],
      }} /></div>}>
      <NoticeUserView detail={notice} />
    </NoticeStageTabs>);
    const noticePanel = screen.getByRole("tabpanel", { name: "공고" });
    expect(noticePanel).toHaveTextContent("R26BK01766517-000, R26BK01766517-001");
    expect(within(noticePanel).getAllByRole("link", { name: "R26BK01766517-000" })[0])
      .toHaveAttribute("href", "/bids/R26BK01766517--000");
    expect(within(noticePanel).getAllByRole("link", { name: "R26BK01766517-000" })).toHaveLength(2);
    expect(within(noticePanel).queryByRole("button", { name: "R26BK01766517-001" })).not.toBeInTheDocument();
    fireEvent.click(within(noticePanel).getByRole("button", { name: "R26DD20897516" }));
    const planPanel = screen.getByRole("tabpanel", { name: "발주계획" });
    expect(planPanel).toBeVisible();
    expect(document.getElementById("notice-reference-R26DD20897516")).toHaveFocus();
    expect(within(planPanel).queryByRole("button", { name: "R26DD20897516" })).not.toBeInTheDocument();
    fireEvent.click(within(planPanel).getByRole("button", { name: "R26BK01766517-001" }));
    expect(noticePanel).toBeVisible();
    fireEvent.click(within(noticePanel).getByRole("button", { name: "R26BD00283215" }));
    const specPanel = screen.getByRole("tabpanel", { name: "사전규격" });
    expect(specPanel).toBeVisible();
    expect(within(specPanel).queryByRole("button", { name: "R26BD00283215" })).not.toBeInTheDocument();
    expect(within(specPanel).getByRole("button", { name: "R26DD20897516" })).toBeInTheDocument();
  });

  it("같은 개찰완료 값이라도 클릭한 행의 상세로 이동합니다", () => {
    const targets = { currentKey: "R26BK01766517--001", relatedKeys: [], planNumbers: [], specNumbers: [],
      opening: [0, 1].map((row) => ({ number: `opening--R26BK01766517--001--00${row}`,
        triggers: [{ sectionHint: "입찰진행현황", value: "개찰완료",
          html: `<button id="gridViewPgst_button_${row}_1">개찰완료</button>` }] })) };
    const detail: ScrapedDetail = { sourceUrl: "", attachments: [], links: [], sections: [{
      title: "입찰진행현황", fields: [], tables: [{
        headerRows: [[{ value: "재입찰번호", column: 0, rowspan: 1, colspan: 1 },
          { value: "진행현황", column: 1, rowspan: 1, colspan: 1 }]],
        bodyRows: [0, 1].map((row) => [
          { value: `00${row}`, column: 0, rowspan: 1, colspan: 1 },
          { value: "개찰완료", column: 1, rowspan: 1, colspan: 1 },
        ]),
      }],
    }] };
    render(<NoticeStageTabs targets={targets}
      opening={<><div id="notice-reference-opening--R26BK01766517--001--000" tabIndex={-1}>첫 개찰</div>
        <div id="notice-reference-opening--R26BK01766517--001--001" tabIndex={-1}>둘째 개찰</div></>}>
      <NoticeUserView detail={detail} />
    </NoticeStageTabs>);
    const noticePanel = screen.getByRole("tabpanel", { name: "공고" });
    const statuses = within(noticePanel).getAllByRole("button", { name: "개찰완료" });
    fireEvent.click(statuses[1]);
    expect(screen.getByRole("tabpanel", { name: "개찰" })).toBeVisible();
    expect(document.getElementById("notice-reference-opening--R26BK01766517--001--001")).toHaveFocus();
    fireEvent.click(screen.getByRole("tab", { name: "공고" }));
    fireEvent.click(within(noticePanel).getAllByRole("button", { name: "개찰완료" })[0]);
    expect(document.getElementById("notice-reference-opening--R26BK01766517--001--000")).toHaveFocus();
  });
});
