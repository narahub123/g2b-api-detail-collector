import { describe, expect, it } from "vitest";
import { normalizeNotice } from "./normalize";

describe("normalizeNotice", () => {
  const api = {
    bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "조사 용역",
    dminsttNm: "발주기관", bidNtceDt: "2026-10-01 10:00:00",
    bidClseDt: "2026-10-12 10:00:00", presmptPrce: "12,000,000"
  };

  it("uses only visible field pieces for user-facing normalized values", () => {
    const notice = normalizeNotice(api, { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [],
      sections: [{ title: "공고일반", tables: [], fields: [
        { label: "공고명", value: [{ text: "숨긴 제목", visible: false }, { text: "표시 제목", visible: true }] },
        { label: "공고기관", visible: false, value: [{ text: "숨긴 기관", visible: true }] }
      ] }] });
    expect(notice.title).toEqual({ value: "표시 제목", source: "detail" });
    expect(notice.demandAgency).toEqual({ value: "발주기관", source: "api" });
    expect(notice.noticeAgency).toEqual({ value: null, source: null });
  });

  it("uses the first nonempty occurrence of a label in section order", () => {
    const detail = { sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [], sections: [
      { title: "공고일반", fields: [
        { label: "공고명", value: [] }, { label: "공고기관", value: [{ text: "첫 기관", visible: true }] },
        { label: "지역제한", value: [{ text: "서울", visible: true }] }
      ], tables: [] },
      { title: "입찰자격", fields: [
        { label: "공고명", value: [{ text: "첫 유효 공고명", visible: true }] }, { label: "공고기관", value: [{ text: "둘째 기관", visible: true }] },
        { label: "지역제한", value: [{ text: "부산", visible: true }] }
      ], tables: [] }
    ] };
    const notice = normalizeNotice(api, detail);
    expect(notice.title).toEqual({ value: "첫 유효 공고명", source: "detail" });
    expect(notice.noticeAgency).toEqual({ value: "첫 기관", source: "detail" });
    expect(notice.demandAgency).toEqual({ value: "발주기관", source: "api" });
    expect(notice.region).toEqual({ value: "서울", source: "detail" });
  });

  it("참가가능지역의 단일 대괄호 지역명을 지역제한보다 우선합니다", () => {
    const notice = normalizeNotice({ ...api, prtcptPsblRgnNm: "API 지역" }, {
      sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [],
      sections: [{ title: "입찰자격", tables: [], fields: [
        { label: "지역제한", value: [{ text: "서울특별시", visible: true }] },
        { label: "참가가능지역", value: [{ text: "참여 가능 [부산광역시] 상세 안내", visible: true }] }
      ] }]
    });
    expect(notice.region).toEqual({ value: "부산광역시", source: "detail" });
  });

  it("참가가능지역의 복수 대괄호 지역명을 쉼표로 연결합니다", () => {
    const notice = normalizeNotice(api, {
      sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [],
      sections: [{ title: "입찰자격", tables: [], fields: [
        { label: "참가가능지역", value: [
          { text: "[서울특별시], ", visible: true }, { text: "[경기도]", visible: true },
          { text: " (자세한 사항은 공고문 참조)", visible: true }
        ] }
      ] }]
    });
    expect(notice.region).toEqual({ value: "서울특별시, 경기도", source: "detail" });
  });

  it.each([
    [{ text: "지역은 공고문을 참조하세요.", visible: true }],
    [{ text: "", visible: true }],
    [{ text: "[숨긴 지역]", visible: false }]
  ])("참가가능지역에서 지역명을 추출하지 못하면 지역제한을 사용합니다", (...value) => {
    const notice = normalizeNotice({ ...api, prtcptPsblRgnNm: "API 지역" }, {
      sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [],
      sections: [{ title: "입찰자격", tables: [], fields: [
        { label: "참가가능지역", value },
        { label: "지역제한", value: [{ text: "대구광역시", visible: true }] }
      ] }]
    });
    expect(notice.region).toEqual({ value: "대구광역시", source: "detail" });
  });

  it("상세 필드에서 지역명을 얻지 못하면 API 지역명을 사용합니다", () => {
    const notice = normalizeNotice({ ...api, prtcptPsblRgnNm: "인천광역시" }, {
      sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [],
      sections: [{ title: "입찰자격", tables: [], fields: [
        { label: "참가가능지역", value: [{ text: "공고문 참조", visible: true }] },
        { label: "지역제한", value: [] }
      ] }]
    });
    expect(notice.region).toEqual({ value: "인천광역시", source: "api" });
  });

  it("수요기관과 공고기관을 각각 해당 상세 필드와 API 필드에서 선택합니다", () => {
    const notice = normalizeNotice({ ...api, ntceInsttNm: "조달청" }, {
      sourceUrl: "https://www.g2b.go.kr/", attachments: [], links: [],
      sections: [{ title: "공고일반", tables: [], fields: [
        { label: "수요기관", value: [{ text: "국무조정실", visible: true }] },
        { label: "공고기관", visible: false, value: [{ text: "숨긴 공고기관", visible: true }] }
      ] }]
    });
    expect(notice.demandAgency).toEqual({ value: "국무조정실", source: "detail" });
    expect(notice.noticeAgency).toEqual({ value: "조달청", source: "api" });
  });

  it("한 기관만 있으면 다른 기관을 채우지 않습니다", () => {
    const notice = normalizeNotice({ bidNtceNo: "R26BK1", bidNtceOrd: "000", ntceInsttNm: "조달청" }, null);
    expect(notice.demandAgency).toEqual({ value: null, source: null });
    expect(notice.noticeAgency).toEqual({ value: "조달청", source: "api" });
  });

  it("keeps source labels when rendered detail values take priority", () => {
    const notice = normalizeNotice(api, {
      sourceUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK1&bidPbancOrd=000",
      sections: [{ title: "공고일반", fields: [
        { label: "공고명", value: [{ text: "조사 용역 변경", visible: true }] }, { label: "입찰자격", value: [{ text: "중소기업", visible: true }] },
        { label: "지역제한", value: [{ text: "서울특별시", visible: true }] }
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
        { label: "업종제한사항", value: [{ text: "학술.연구용역(1169)", visible: true }] }
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
        { label: "공고명", value: [{ text: "이전 차수 공고", visible: true }] }, { label: "공고기관", value: [{ text: "고흥군", visible: true }] }
      ], tables: [] }], text: "공고 본문", attachments: [], links: []
    }, { number: "R26BK01766517", order: "001" });
    expect(notice.key).toBe("R26BK01766517--001");
    expect(notice.title).toEqual({ value: "이전 차수 공고", source: "detail" });
    expect(notice.scrapeStatus).toBe("succeeded");
  });
});
