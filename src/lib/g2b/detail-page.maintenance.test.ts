import { expect, it, vi } from "vitest";
import { chromium } from "playwright-core";
import { scrapeDetailPage } from "./detail-page";

it("상세 점검은 공고 요소 대기 전에 감지하고 브라우저를 닫습니다", async () => {
  const close=vi.fn(),goto=vi.fn(),locator=vi.fn();
  const launch=vi.spyOn(chromium,"launch").mockResolvedValue({close,newPage:async()=>({
    on:vi.fn(),goto,locator,content:async()=>'<title>시스템 점검 안내</title><p>현재 웹서비스가 중단되고 있음을 알려드립니다.</p>',
  })} as never);
  try {
    await expect(scrapeDetailPage("https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK1&bidPbancOrd=000"))
      .rejects.toMatchObject({maintenance:{source:"detail"}});
    expect(goto).toHaveBeenCalledOnce();expect(locator).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
  } finally { launch.mockRestore(); }
});
