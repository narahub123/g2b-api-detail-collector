import { expect, it } from "vitest";
import { scrapeDetailPage } from "./detail-page";

it.skipIf(!process.env.LIVE_G2B)("reads a public rendered service notice", async () => {
  const detail = await scrapeDetailPage("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01741650&bidPbancOrd=000");
  expect(detail.fields["공고명"]).toContain("유가공업 실태조사");
  expect(Object.keys(detail.fields).length).toBeGreaterThan(14);
  expect(detail.attachments.length).toBeGreaterThan(0);
  expect(detail.attachments[0].url).toContain("/downloadFile.do?");
}, 60_000);
