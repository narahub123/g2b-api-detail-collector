import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeNotice } from "@/lib/g2b/normalize";

const { getNoticeRecord, listPublicNoticeKeys } = vi.hoisted(() => ({ getNoticeRecord: vi.fn(), listPublicNoticeKeys: vi.fn() }));
vi.mock("@/lib/g2b/notices", () => ({ getNoticeRecord, listPublicNoticeKeys }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
import BidUserViewPage from "./page";

describe("사용자 공고 상세 페이지", () => {
  it("상세 수집 전이거나 실패한 공고의 직접 주소를 숨깁니다", async () => {
    for (const detailError of [null, "상세 접근 실패"]) {
      getNoticeRecord.mockResolvedValueOnce({ detail: null, detailError });
      await expect(BidUserViewPage({ params: Promise.resolve({ key: "R26BK1--000" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("상단에는 수요기관만 표시합니다", async () => {
    getNoticeRecord.mockResolvedValue({
      normalized: normalizeNotice({ bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "조사 용역",
        dminsttNm: "국무조정실", ntceInsttNm: "조달청" },
        { sourceUrl: "https://www.g2b.go.kr", attachments: [], links: [], sections: [] }),
      detail: { sourceUrl: "https://www.g2b.go.kr", attachments: [], links: [], sections: [] },
      relatedNoticeKeys: [], orderPlans: [], preSpecifications: [], otherDetails: [], openingDetails: []
    });
    listPublicNoticeKeys.mockResolvedValue([]);
    const html = renderToStaticMarkup(await BidUserViewPage({ params: Promise.resolve({ key: "R26BK1--000" }) }));
    expect(html).toContain("수요기관: 국무조정실");
    expect(html).not.toContain("공고기관: 조달청");
  });

  it("관련 공고 중 상세 수집에 성공한 공고만 연결합니다", async () => {
    const detail = { sourceUrl: "https://www.g2b.go.kr", attachments: [], links: [], sections: [] };
    getNoticeRecord.mockResolvedValue({
      normalized: normalizeNotice({ bidNtceNo: "R26BK1", bidNtceOrd: "000" }, detail), detail,
      relatedNoticeKeys: ["R26BK2--000", "R26BK3--000"], orderPlans: [], preSpecifications: [],
      otherDetails: [], openingDetails: []
    });
    listPublicNoticeKeys.mockResolvedValue(["R26BK2--000"]);
    const html = renderToStaticMarkup(await BidUserViewPage({ params: Promise.resolve({ key: "R26BK1--000" }) }));
    expect(html).toContain('href="/bids/R26BK2--000"');
    expect(html).not.toContain('href="/bids/R26BK3--000"');
  });
});
