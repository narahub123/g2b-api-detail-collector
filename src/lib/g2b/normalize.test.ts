import { describe, expect, it } from "vitest";
import { normalizeNotice } from "./normalize";

describe("normalizeNotice", () => {
  const api = {
    bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "조사 용역",
    dminsttNm: "발주기관", bidNtceDt: "2026-10-01 10:00:00",
    bidClseDt: "2026-10-12 10:00:00", presmptPrce: "12,000,000"
  };

  it("keeps source labels when rendered detail values take priority", () => {
    const notice = normalizeNotice(api, {
      sourceUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK1&bidPbancOrd=000",
      fields: { "공고명": "조사 용역 변경", "입찰자격": "중소기업", "지역제한": "서울특별시" },
      text: "조사 업무", attachments: [], links: []
    });
    expect(notice.title).toEqual({ value: "조사 용역 변경", source: "detail" });
    expect(notice.amount).toEqual({ value: "12,000,000", source: "api" });
    expect(notice.qualifications).toEqual({ value: "중소기업", source: "detail" });
    expect(notice.region).toEqual({ value: "서울특별시", source: "detail" });
  });

  it("keeps a usable API notice when detail scraping fails", () => {
    const notice = normalizeNotice({ ...api, bidPrtcptQlfctRgstDt: "2026-10-11" }, null);
    expect(notice.title.value).toBe("조사 용역");
    expect(notice.qualifications.value).toBeNull();
    expect(notice.scrapeStatus).toBe("failed");
  });

  it("rejects unsafe attachment URLs and keeps missing fields null", () => {
    const notice = normalizeNotice(api, {
      sourceUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK1&bidPbancOrd=000",
      fields: {}, text: "조사 업무", attachments: [{ name: "공고.pdf", url: "javascript:alert(1)" }], links: []
    });
    expect(notice.attachments).toEqual([]);
    expect(notice.servicePeriod.value).toBeNull();
  });

  it("reads actual industry qualification and rejects invalid dates", () => {
    const notice = normalizeNotice({ ...api, bidNtceDt: "2026-99-99 nonsense", bidClseDt: "invalid" }, {
      sourceUrl: "https://www.g2b.go.kr/", fields: { "업종제한사항": "학술.연구용역(1169)" },
      text: "", attachments: [], links: []
    });
    expect(notice.qualifications.value).toBe("학술.연구용역(1169)");
    expect(notice.postedAt.value).toBeNull();
    expect(notice.deadline.value).toBeNull();
    expect(notice.validationIssues.map((issue) => issue.field)).toEqual(["postedAt", "deadline"]);
  });
});
