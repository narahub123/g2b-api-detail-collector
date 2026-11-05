import type * as cheerio from "cheerio";

/** 선택 없음과 다중 선택을 보존하며 옵션 코드 대신 표시 문자열을 반환합니다. */
export function selectedOptionText($: cheerio.CheerioAPI, select: cheerio.Cheerio<any>): string {
  if (select.is("[data-g2b-no-selection]")) return "";
  return select.find("option:selected").toArray().map(option => $(option).text()).join(" ");
}
