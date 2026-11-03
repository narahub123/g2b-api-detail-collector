import { expect, it } from "vitest";
import { checkExtractedContent, checkPreservedContent, runContentCheck } from "./content-check";
import { extractCommonSections } from "./common-content-extractor";
import { structureNoticeDetail } from "./structured-data";
import type { ScrapedDetail } from "./detail-page";
import type { CollectionStage } from "./collection-progress";
import { createCollectionObserver } from "./collection-observer";
import type { CollectionJob } from "./collection-job";

const html = `<main><div class="dfbox"><div class="fl"><h4 class="df_tit">안내</h4></div></div>
  <p>첫 안내문</p><p>둘째 안내문</p><table><tr><td data-title="조건"><p>필드 안내문</p></td></tr></table>
  <button>저장</button></main>`;

it("정상 필드·본문은 통과하고 본문 일부만 누락돼도 섹션 경고를 생성합니다", () => {
  const sections = extractCommonSections(html, "page");
  expect(checkExtractedContent(html, "page", sections)).toEqual([]);
  sections[0].textBlocks!.splice(1, 1);
  expect(checkExtractedContent(html, "page", sections)).toMatchObject([{ section: "안내", message: expect.stringContaining("둘째 안내문") }]);
});

it("빈 안내와 탐색 메뉴는 제외하고 같은 제목의 서로 다른 섹션은 개별 대조합니다", () => {
  const source = `<main><nav>공통 메뉴</nav><div class="dfbox"><div class="fl"><h4 class="df_tit">안내</h4></div></div><p>첫째</p>
    <div class="dfbox"><div class="fl"><h4 class="df_tit">안내</h4></div></div><p>둘째</p><p> </p></main>`;
  const sections = extractCommonSections(source, "page");
  sections[1].textBlocks = [];
  expect(checkExtractedContent(source, "page", sections)).toMatchObject([{ section: "안내", message: expect.stringContaining("둘째") }]);
});

it("같은 문단이 반복되면 한 개의 저장값으로 두 번의 본문을 충족하지 않습니다", () => {
  const source = html.replace("둘째 안내문", "첫 안내문");
  const sections = extractCommonSections(source, "page"); sections[0].textBlocks!.pop();
  expect(checkExtractedContent(source, "page", sections)).toHaveLength(1);
});

it("필드의 같은 문구가 별도 본문의 누락을 가리지 않으며 필드 중복 제거는 허용합니다", () => {
  const source = html.replace("<p>첫 안내문</p><p>둘째 안내문</p>", "<p>필드 안내문</p>")
    .replace("</table>", `<tr><td data-title="조건"><p>필드 안내문</p></td></tr></table>`);
  const sections = extractCommonSections(source, "page");
  expect(checkExtractedContent(source, "page", sections)).toEqual([]);
  sections[0].textBlocks = [];
  expect(checkExtractedContent(source, "page", sections)).toHaveLength(1);
});

it("모달과 독립 상세로 이동한 본문은 통과하고 구조화 후 손실은 경고합니다", () => {
  const input: ScrapedDetail = { sourceUrl: "https://www.g2b.go.kr/", sections: extractCommonSections(html, "page"), attachments: [], links: [],
    modalCaptures: [{ trigger: { index: 0, tag: "a", label: "규격", value: "R26BD12345678", html: "" },
      modal: { title: "규격", sections: [{ title: "규격 안내", fields: [], tables: [], textBlocks: [{ text: "규격 본문", visible: true }] }] } }] };
  const output = structureNoticeDetail("R26BK1--000", input);
  expect(checkPreservedContent("R26BK1--000", input, output)).toEqual([]);
  output.preSpecifications[0].sections![0].textBlocks = [];
  expect(checkPreservedContent("R26BK1--000", input, output)).toMatchObject([{ section: "규격 안내", message: expect.stringContaining("규격 본문") }]);
});

it("검사 실패는 별도 경고로 남기고 원래 처리 단계로 복귀합니다", async () => {
  const stages: CollectionStage[] = [], warnings: string[] = [];
  await runContentCheck("extraction-check", () => { throw Error("비교 실패"); },
    issue => warnings.push(issue.message), async stage => { stages.push(stage); }, "modals");
  expect(stages).toEqual(["extraction-check", "modals"]);
  expect(warnings).toEqual([expect.stringContaining("검사 실패: 비교 실패")]);
});

it("두 검사는 정상·누락·검사 실패 모두 계측하고 경고 생성 시간도 각각 포함합니다", async () => {
  let elapsed = 0;
  const job: CollectionJob = { id: "check-timings", status: "running", phase: "detail", range: null,
    apiCount: 0, detailSucceeded: 0, detailFailed: 0, errors: [], startedAt: new Date(0).toISOString() };
  const result = { key: "R26BK1--000", status: "pending" as "pending" | "succeeded" };
  job.results = [result];
  const observer = createCollectionObserver(job, async () => {}, () => 0, () => elapsed);
  await observer.begin(result); await observer.progress("extracting", result);
  await runContentCheck("extraction-check", () => { elapsed += 10; return []; }, () => {}, stage => observer.progress(stage, result), "extracting");
  await runContentCheck("extraction-check", () => { elapsed += 20; return [{ section: "안내", message: "누락" }]; },
    () => { elapsed += 3; }, stage => observer.progress(stage, result), "extracting");
  await observer.progress("structuring", result);
  await runContentCheck("preservation-check", () => { elapsed += 7; throw Error("실패"); },
    () => { elapsed += 2; }, stage => observer.progress(stage, result));
  result.status = "succeeded"; await observer.finish(result);
  expect(job.timings?.totals["extraction-check"]).toBe(33);
  expect(job.timings?.totals["preservation-check"]).toBe(9);
  expect(job.timings?.totals.extracting).toBe(0);
  expect(job.timings?.totals.structuring).toBe(0);
});
