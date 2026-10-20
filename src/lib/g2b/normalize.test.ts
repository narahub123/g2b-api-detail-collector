import { describe, expect, it } from "vitest";
import { normalizeNotice } from "./normalize";

describe("normalizeNotice", () => {
  const api = {
    bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "조사 용역",
    dminsttNm: "발주기관", bidNtceDt: "2026-10-01 10:00:00",
    bidClseDt: "2026-10-12 10:00:00", presmptPrce: "12,000,000"
  };

  it("uses the first nonempty occurrence of a label in section order", () => {
    const detail = { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [], sections: [
      { title: "공고일반", fields: [
        { label: "공고명", value: null }, { label: "공고기관", value: "첫 기관" },
        { label: "지역제한", value: "서울" }
      ], tables: [] },
      { title: "입찰자격", fields: [
        { label: "공고명", value: "첫 유효 공고명" }, { label: "공고기관", value: "둘째 기관" },
        { label: "지역제한", value: "부산" }
      ], tables: [] }
    ] };
    const notice = normalizeNotice(api, detail);
    expect(notice.title).toEqual({ value: "첫 유효 공고명", source: "detail" });
    expect(notice.agency).toEqual({ value: "첫 기관", source: "detail" });
    expect(notice.region).toEqual({ value: "서울", source: "detail" });
  });

  it("keeps source labels when rendered detail values take priority", () => {
    const notice = normalizeNotice(api, {
      sourceUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK1&bidPbancOrd=000",
      sections: [{ title: "공고일반", fields: [
        { label: "공고명", value: "조사 용역 변경" }, { label: "입찰자격", value: "중소기업" },
        { label: "지역제한", value: "서울특별시" }
      ], tables: [] }],
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
      sections: [], text: "조사 업무", attachments: [{ name: "공고.pdf", url: "javascript:alert(1)" }], links: []
    });
    expect(notice.attachments).toEqual([]);
    expect(notice.servicePeriod.value).toBeNull();
  });

  it("keeps G2B direct links and distinct internal downloads with the same filename", () => {
    const base = "/api/attachments/R26BK1--000?fileNo=de557b90-5d96-430d-9dd4-06b2d7b3627c&seq=";
    const notice = normalizeNotice(api, { sourceUrl: "https://www.g2b.go.kr/", sections: [], links: [], attachments: [
      { name: "같은 이름.hwpx", url: `${base}1` },
      { name: "같은 이름.hwpx", url: `${base}2` },
      { name: "공고문.pdf", url: "http://www.g2b.go.kr/file.pdf" },
      { name: "외부.pdf", url: "https://evil.example/file.pdf" },
      { name: "다른경로.pdf", url: "/api/other/file" }
    ] });
    expect(notice.attachments).toEqual([
      { name: "같은 이름.hwpx", url: `${base}1` },
      { name: "같은 이름.hwpx", url: `${base}2` },
      { name: "공고문.pdf", url: "http://www.g2b.go.kr/file.pdf" }
    ]);
  });

  it("reads actual industry qualification and rejects invalid dates", () => {
    const notice = normalizeNotice({ ...api, bidNtceDt: "2026-99-99 nonsense", bidClseDt: "invalid" }, {
      sourceUrl: "https://www.g2b.go.kr/", sections: [{ title: "입찰자격", fields: [
        { label: "업종제한사항", value: "학술.연구용역(1169)" }
      ], tables: [] }],
      text: "", attachments: [], links: []
    });
    expect(notice.qualifications.value).toBe("학술.연구용역(1169)");
    expect(notice.postedAt.value).toBeNull();
    expect(notice.deadline.value).toBeNull();
    expect(notice.validationIssues.map((issue) => issue.field)).toEqual(["postedAt", "deadline"]);
  });

  it("normalizes an independent related notice before its API item arrives", () => {
    const notice = normalizeNotice(null, {
      sourceUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01766517&bidPbancOrd=001",
      sections: [{ title: "공고일반", fields: [
        { label: "공고명", value: "이전 차수 공고" }, { label: "공고기관", value: "고흥군" }
      ], tables: [] }], text: "공고 본문", attachments: [], links: []
    }, { number: "R26BK01766517", order: "001" });
    expect(notice.key).toBe("R26BK01766517--001");
    expect(notice.title).toEqual({ value: "이전 차수 공고", source: "detail" });
    expect(notice.scrapeStatus).toBe("succeeded");
  });
});
