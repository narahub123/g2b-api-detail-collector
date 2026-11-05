import type * as cheerio from "cheerio";

/** 첨부 조작 UI의 용량 안내 문장 전체가 일치할 때만 제외합니다. */
function isCapacityUi(text: string): boolean {
  const normalized = text.replace(/\s+/g, "").replace(/^[※ㆍ•*]+/, "");
  return /^현재용량[\d.,]+\/[\d.,]+(?:K|M|G)?B$/i.test(normalized) ||
    /^첨부파일용량은파일당\d+(?:\.\d+)?(?:K|M|G)(?:B)?이하입니다[.!。]?$/i.test(normalized);
}

/**
 * 첨부 컴포넌트의 용량 표시와 업로드 제한만 수집 대상에서 제외합니다.
 * @returns 제외할 요소 집합. 업무 본문과 파일 행은 포함하지 않습니다.
 */
export function attachmentUiNodes($: cheerio.CheerioAPI): Set<any> {
  const excluded = new Set<any>();
  const attachmentGrids = $("table").filter((_, table) => $(table).is("[id$='grdFile_body_table']") ||
    $(table).find("td[col_id='orgnlAtchFileNm']").toArray().some(cell => $(cell).closest("table")[0] === table));
  // 첨부 표를 포함하는 가장 가까운 컨테이너에만 적용합니다.
  attachmentGrids.each((_, table) => {
    const ancestors = $(table).parents().toArray();
    const boundary = ancestors.findIndex(node => $(node).is("html,body,main,[role='dialog']") ||
      $(node).find(".df_tit").length > 1);
    const container = ancestors.slice(0, boundary < 0 ? ancestors.length : boundary).find(node => {
      return $(node).find("[id$='_spnFileSize'],p,span,div").toArray().some(child => {
        if ($(child).closest("table")[0] === table) return false;
        return isCapacityUi($(child).text());
      });
    });
    if (!container) return;
    $(container).find("[id$='_spnFileSize'],p,span,div").each((_, node) => {
      const element = $(node);
      if (element.closest("table")[0] === table || element.find("table,input,select,textarea,a").length) return;
      if (isCapacityUi(element.text())) excluded.add(node);
    });
  });
  return excluded;
}
