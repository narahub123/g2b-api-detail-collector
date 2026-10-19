import { expect, it } from "vitest";
import { scrapeDetailPage } from "./detail-page";

it.skipIf(!process.env.LIVE_G2B)("reads a public rendered service notice", async () => {
  const { detail } = await scrapeDetailPage("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01741650&bidPbancOrd=000");
  expect(detail.fields["공고명"]).toContain("유가공업 실태조사");
  expect(Object.keys(detail.fields).length).toBeGreaterThan(14);
  expect(detail.attachments.length).toBeGreaterThan(0);
  expect(detail.attachments[0].url).toContain("/downloadFile.do?");
}, 60_000);

it.skipIf(!process.env.LIVE_G2B)("captures a public notice's basic-price dialog", async () => {
  const { detail } = await scrapeDetailPage("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01764337&bidPbancOrd=000");
  const capture = detail.modalCaptures?.find((item) => item.trigger.label === "기초금액조회");
  expect(detail.attachments).toHaveLength(3);
  expect(capture?.modal.title).toBe("기초가격상세조회");
  expect(capture?.modal.fields).toContainEqual({ label: "입찰공고번호", value: "R26BK01764337-000" });
  expect(detail.modalDiscovery?.failures).toEqual([]);
  const titles = detail.sections?.map((section) => section.title) || [];
  expect(titles.indexOf("가격")).toBeLessThan(titles.indexOf("기초금액공개"));
  expect(titles.indexOf("기초금액공개")).toBeLessThan(titles.indexOf("기관담당자정보"));
  expect(detail.links.some((link) => link.label === "본문영역 바로가기")).toBe(false);
  for (const section of detail.sections || []) {
    expect(new Set(section.fields.map((field) => `${field.label}\u0000${field.value}`)).size).toBe(section.fields.length);
  }
}, 120_000);

it.skipIf(!process.env.LIVE_G2B)("captures the notice dialog and related orders of R26BK01766517", async () => {
  const { detail, relatedNoticeKeys } = await scrapeDetailPage("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01766517&bidPbancOrd=002");
  expect(relatedNoticeKeys).toEqual(expect.arrayContaining(["R26BK01766517--001", "R26BK01766517--000"]));
  const noticeCapture = detail.modalCaptures?.find((capture) => capture.modal.title?.includes("공지사항"));
  expect(noticeCapture?.modal.fields.some((field) => Boolean(field.value)) || (noticeCapture?.modal.text.length || 0) > 50).toBe(true);
  expect(detail.modalCaptures?.some((capture) => capture.modal.title?.includes("발주계획"))).toBe(true);
}, 180_000);
