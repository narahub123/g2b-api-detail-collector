import type { ModalCapture, StructuredSection } from "./detail-page";

export type TabModalCategory = "opening";
export type TabModalMatch = { category: TabModalCategory; key: string };

type TabModalRule = {
  category: TabModalCategory;
  title: string;
  sectionHint: string;
  key: (noticeKey: string, capture: ModalCapture, sections: StructuredSection[]) => string | null;
};

/** 클릭한 진행현황 행에서 재입찰번호를 확인해 개찰 상세의 저장 키를 만듭니다. */
function openingKey(noticeKey: string, capture: ModalCapture, sections: StructuredSection[]): string | null {
  const buttonId = /gridViewPgst_button_(\d+)_(\d+)/.exec(capture.trigger.html);
  if (!buttonId) return null;
  const rowIndex = Number(buttonId[1]);
  const columnIndex = Number(buttonId[2]);
  const sourceSections = sections.filter((section) => section.title === capture.trigger.sectionHint);
  if (sourceSections.length !== 1) return null;
  const matches = sourceSections[0].tables.flatMap((table) => {
    const headers = table.headerRows.flat();
    const rebidColumn = headers.find((cell) => cell.value === "재입찰번호")?.column;
    const statusColumn = headers.find((cell) => cell.value === "진행현황")?.column;
    const row = table.bodyRows[rowIndex];
    if (rebidColumn === undefined || statusColumn !== columnIndex || !row ||
      row.find((cell) => cell.column === statusColumn)?.value !== capture.trigger.value) return [];
    const rebid = row.find((cell) => cell.column === rebidColumn)?.value?.trim();
    return rebid && /^\d{3}$/.test(rebid) ? [rebid] : [];
  });
  return matches.length === 1 ? `opening--${noticeKey}--${matches[0]}` : null;
}

// 탭 유형을 추가할 때 수집 로직 대신 이 목록의 식별 조건과 키 생성 규칙을 확장합니다.
const tabModalRules: TabModalRule[] = [
  { category: "opening", title: "개찰결과상세조회", sectionHint: "입찰진행현황", key: openingKey }
];

/** 번호 형식이 아닌 클릭 모달에 설정된 탭 분류 규칙을 적용합니다. */
export function classifyTabModal(noticeKey: string, capture: ModalCapture,
  sections: StructuredSection[]): { configured: boolean; match: TabModalMatch | null } {
  const rule = tabModalRules.find((item) => item.title === capture.modal.title &&
    item.sectionHint === capture.trigger.sectionHint && !capture.trigger.parentModalTitle);
  if (!rule) return { configured: false, match: null };
  const key = rule.key(noticeKey, capture, sections);
  return { configured: true, match: key ? { category: rule.category, key } : null };
}
