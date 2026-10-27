import { beforeEach, describe, expect, it, vi } from "vitest";

const { countStoredNotices, listStoredNoticeKeys } = vi.hoisted(() => ({
  countStoredNotices: vi.fn(), listStoredNoticeKeys: vi.fn(async () => [])
}));
vi.mock("./postgres-store", () => ({ countStoredNotices, listStoredNoticeKeys }));
import { listNoticePage } from "./notices";

beforeEach(() => { vi.clearAllMocks(); });

describe("listNoticePage", () => {
  it.each([
    [0, 9, 1, 0, false],
    [10, 9, 1, 1, true],
    [11, 9, 2, 2, true]
  ])("전체 %i건에서 요청 페이지 %i를 경계에 맞춥니다", async (total, requested, page, totalPages, query) => {
    countStoredNotices.mockResolvedValue(total);
    const filters = { query: "용역", searchField: "title" as const };
    const result = await listNoticePage(filters, requested);
    expect(result).toMatchObject({ notices: [], totalCount: total, page, totalPages });
    expect(countStoredNotices).toHaveBeenCalledWith(filters);
    if (query) expect(listStoredNoticeKeys).toHaveBeenCalledWith(filters, { limit: 10, offset: (page - 1) * 10 });
    else expect(listStoredNoticeKeys).not.toHaveBeenCalled();
  });
});
