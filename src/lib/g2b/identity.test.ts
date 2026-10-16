import { describe, expect, it } from "vitest";
import { noticeKey } from "./identity";

describe("noticeKey", () => {
  it("distinguishes announcement orders and preserves leading zeroes", () => {
    expect(noticeKey({ bidNtceNo: "R26BK000001", bidNtceOrd: "00" }))
      .not.toBe(noticeKey({ bidNtceNo: "R26BK000001", bidNtceOrd: "01" }));
    expect(noticeKey({ bidNtceNo: "R26BK000001", bidNtceOrd: "00" })).toContain("00");
  });

  it("rejects missing identifiers", () => {
    expect(() => noticeKey({ bidNtceNo: "R26BK000001" })).toThrow();
  });
});
