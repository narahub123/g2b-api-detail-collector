import { describe, expect, it } from "vitest";
import { noticeKey, noticeKeyFromParts } from "./identity";

describe("noticeKey", () => {
  it("distinguishes announcement orders and preserves leading zeroes", () => {
    expect(noticeKey({ bidNtceNo: "R26BK000001", bidNtceOrd: "00" }))
      .not.toBe(noticeKey({ bidNtceNo: "R26BK000001", bidNtceOrd: "01" }));
    expect(noticeKey({ bidNtceNo: "R26BK000001", bidNtceOrd: "00" })).toContain("00");
  });

  it("rejects missing identifiers", () => {
    expect(() => noticeKey({ bidNtceNo: "R26BK000001" })).toThrow();
  });

  it("builds the same stable key from related notice number and order", () => {
    expect(noticeKeyFromParts("R26BK01766517", "001")).toBe("R26BK01766517--001");
    expect(() => noticeKeyFromParts("R26BK01766517", "")).toThrow();
  });
});
