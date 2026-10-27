import { describe, expect, it } from "vitest";
import { openingTargetForCell, splitNavigationValue } from "./notice-navigation";

const targets = {
  currentKey: "R26BK01766517--001",
  relatedKeys: ["R26BK01766517--000", "R26BK01766517--002"],
  planNumbers: ["R26DD20897516"],
  specNumbers: ["R26BD00283215"],
  opening: [],
};

describe("공고 본문 이동 대상 판별", () => {
  it("구분자 없이 이어진 공고번호를 차수별로 나누고 현재 공고도 구별한다", () => {
    expect(splitNavigationValue("이전 R26BK01766517-002R26BK01766517-000 끝", targets)).toEqual([
      { text: "이전 " },
      { text: "R26BK01766517-002", target: { href: "/bids/R26BK01766517--002" } },
      { text: ", " },
      { text: "R26BK01766517-000", target: { href: "/bids/R26BK01766517--000" } },
      { text: " 끝" },
    ]);
    expect(splitNavigationValue("R26BK01766517 - 001", targets)).toEqual([
      { text: "R26BK01766517 - 001", target: { stage: "notice" } },
    ]);
  });

  it("이미 쉼표로 구분된 공고번호에는 구분자를 중복하지 않는다", () => {
    expect(splitNavigationValue("R26BK01766517-002, R26BK01766517-000", targets)).toEqual([
      { text: "R26BK01766517-002", target: { href: "/bids/R26BK01766517--002" } },
      { text: ", " },
      { text: "R26BK01766517-000", target: { href: "/bids/R26BK01766517--000" } },
    ]);
  });

  it("발주계획과 사전규격은 저장된 번호로 연결하고 미확인 번호와 차수 없는 공고는 남긴다", () => {
    expect(splitNavigationValue("R26DD20897516 / R26BD00283215", targets)).toEqual([
      { text: "R26DD20897516", target: { stage: "plan", reference: "R26DD20897516" } },
      { text: " / " },
      { text: "R26BD00283215", target: { stage: "spec", reference: "R26BD00283215" } },
    ]);
    expect(splitNavigationValue("R26DD00000000 R26BK01766517 R26BK01766517-003", targets))
      .toEqual([{ text: "R26DD00000000 R26BK01766517 R26BK01766517-003" }]);
  });

  it("같은 상태값이어도 저장된 트리거의 행과 열이 맞는 개찰 상세만 선택한다", () => {
    const opening = [0, 1].map((row) => ({
      number: `opening--R26BK01766517--001--00${row}`,
      triggers: [{ sectionHint: "입찰진행현황", value: "개찰완료",
        html: `<button id="gridViewPgst_button_${row}_5">개찰완료</button>` }],
    }));
    expect(openingTargetForCell("입찰진행현황", 1, 5, "개찰완료", opening))
      .toEqual({ stage: "opening", reference: "opening--R26BK01766517--001--001" });
    expect(openingTargetForCell("입찰진행현황", 1, 4, "개찰완료", opening)).toBeNull();
    expect(openingTargetForCell("다른 섹션", 1, 5, "개찰완료", opening)).toBeNull();
    expect(openingTargetForCell("입찰진행현황", 1, 5, "개찰대기", opening)).toBeNull();
  });
  it("뒤쪽 페이지의 버튼을 합쳐진 표의 원래 행에 연결한다", () => {
    const opening = [{ number: "opening--R26BK01766517--001--002", triggers: [{
      sectionHint: "입찰진행현황", value: "개찰완료",
      html: '<button id="gridViewPgst_button_0_5">개찰완료</button>',
      path: [{ id: "progress_grid", page: 2, rowOffset: 10 }]
    }] }];
    expect(openingTargetForCell("입찰진행현황", 10, 5, "개찰완료", opening))
      .toEqual({ stage: "opening", reference: opening[0].number });
  });
});
