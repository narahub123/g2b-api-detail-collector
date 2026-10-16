// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoticeList } from "./NoticeList";
import type { NormalizedNotice } from "@/lib/g2b/normalize";

const field = (value: string | null) => ({ value, source: value ? "api" as const : null });
const base: NormalizedNotice = {
  key: "R26BK1--000", number: "R26BK1", order: "000", title: field("조사 용역"), agency: field("기관"),
  postedAt: field("2026-10-01"), deadline: field("2026-10-10"), amount: field("1000000"),
  description: field(null), servicePeriod: field(null), qualifications: field(null), region: field(null),
  attachments: [], originalUrl: "https://www.g2b.go.kr/", scrapeStatus: "succeeded", validationIssues: []
};

describe("NoticeList", () => {
  it("links different orders of one announcement to different detail pages", () => {
    render(<NoticeList notices={[base, { ...base, key: "R26BK1--001", order: "001" }]} />);
    expect(screen.getAllByRole("link", { name: "조사 용역" }).map((link) => link.getAttribute("href")))
      .toEqual(["/bids/R26BK1--000", "/bids/R26BK1--001"]);
  });
});
