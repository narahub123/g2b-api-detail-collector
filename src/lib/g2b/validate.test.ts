import { describe, expect, it } from "vitest";
import { normalizeNotice } from "./normalize";
import { validateNotice } from "./validate";

describe("validateNotice", () => {
  it("flags invalid amount and date without inventing replacements", () => {
    const notice = normalizeNotice({ bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "용역", presmptPrce: "가격 미정", bidNtceDt: "invalid" }, null);
    const issues = validateNotice(notice);
    expect(issues.map((issue) => issue.field)).toContain("amount");
    expect(issues.map((issue) => issue.field)).toContain("postedAt");
    expect(notice.amount.value).toBeNull();
  });
});
