import { describe, expect, it } from "vitest";
import { API_FIELD_LABELS, apiFieldDisplayName } from "./api-field-labels";

describe("API field labels", () => {
  it("contains all 118 fields from the service response specification", () => {
    expect(Object.keys(API_FIELD_LABELS)).toHaveLength(118);
  });
  it("displays Korean name followed by original key", () => {
    expect(apiFieldDisplayName("bidNtceNo")).toBe("입찰공고번호(bidNtceNo)");
    expect(apiFieldDisplayName("srvceDivNm")).toBe("용역구분명(srvceDivNm)");
  });
  it("preserves unknown keys rather than inventing a label", () => {
    expect(apiFieldDisplayName("unknownField")).toBe("unknownField");
  });
});
