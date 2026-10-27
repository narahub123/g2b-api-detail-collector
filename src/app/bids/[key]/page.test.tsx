import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeNotice } from "@/lib/g2b/normalize";

const { getNoticeRecord } = vi.hoisted(() => ({ getNoticeRecord: vi.fn() }));
vi.mock("@/lib/g2b/notices", () => ({ getNoticeRecord }));
import BidUserViewPage from "./page";

describe("사용자 공고 상세 페이지", () => {
  it("상단에는 수요기관만 표시합니다", async () => {
    getNoticeRecord.mockResolvedValue({
      normalized: normalizeNotice({ bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "조사 용역",
        dminsttNm: "국무조정실", ntceInsttNm: "조달청" }, null),
      detail: null, relatedNoticeKeys: [], orderPlans: [], preSpecifications: [], otherDetails: [], openingDetails: []
    });
    const html = renderToStaticMarkup(await BidUserViewPage({ params: Promise.resolve({ key: "R26BK1--000" }) }));
    expect(html).toContain("수요기관: 국무조정실");
    expect(html).not.toContain("공고기관: 조달청");
  });
});
