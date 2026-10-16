import { describe, expect, it } from "vitest";
import { parsePostedDateRange } from "./date-range";

describe("parsePostedDateRange", () => {
  it("keeps both posted dates inclusive", () => {
    expect(parsePostedDateRange("2026-10-01", "2026-10-02")).toEqual({
      start: "2026-10-01",
      end: "2026-10-02"
    });
  });

  it("rejects reversed or impossible dates", () => {
    expect(() => parsePostedDateRange("2026-10-02", "2026-10-01")).toThrow();
    expect(() => parsePostedDateRange("2026-02-30", "2026-03-01")).toThrow();
  });
});
