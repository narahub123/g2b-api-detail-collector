import * as cheerio from "cheerio";
import { extractModalGrid, tableHasValue } from "./structured-table";
import type { StructuredTable } from "./structured-table";
import type {
  ModalCapture,
  ScrapedDetail,
  StructuredField,
} from "./detail-page";

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const nonempty = (value: string): string | null => clean(value) || null;

/**
 * 실시간 폼 값이 반영된 모달 HTML 스냅샷에서 필드와 그리드를 추출합니다.
 * G2B WebSquare는 필드에 td[data-title], 그리드 데이터에 col_id를 사용하며,
 * 그리드 헤더는 필드 레이블로 취급하지 않습니다.
 * @param html 열린 모달의 HTML 스냅샷
 * @returns 모달 제목, 필드 및 구조화된 테이블
 */
export function extractModalStructure(html: string): {
  title: string | null;
  fields: StructuredField[];
  tables: StructuredTable[];
} {
  const $ = cheerio.load(html);
  $("script,style").remove();
  const root = $("[role='dialog']").first().length
    ? $("[role='dialog']").first()
    : $("body");
  const title = nonempty(
    root
      .find("[id$='_header_title'],.w2window_header_title,h1,h2,h3")
      .first()
      .text(),
  );
  const fields: StructuredField[] = [];
  const tables: StructuredTable[] = [];
  const readValue = (cell: cheerio.Cheerio<any>): string | null => {
    const controls = cell
      .find("input,textarea,select")
      .filter(
        (_, el) =>
          !$(el).is("[type='checkbox'],[type='radio'],[type='hidden']"),
      );
    const values = controls
      .toArray()
      .map((el) => {
        const input = $(el);
        if (input.is("textarea"))
          return nonempty(input.val()?.toString() || input.text());
        if (input.is("select"))
          return nonempty(
            input.find("option:selected").text() ||
              input.val()?.toString() ||
              "",
          );
        return nonempty(input.attr("value") || input.val()?.toString() || "");
      })
      .filter((value): value is string => value !== null);
    const plain = cell.clone();
    plain.find("input,textarea,select,button,script,style").remove();
    const breakMarker = "\uE000";
    plain.find("br").replaceWith(breakMarker);
    const plainText = clean(plain.text())
      .split(breakMarker)
      .map(clean)
      .join("\n");
    return [...values, plainText].filter(Boolean).join(" ") || null;
  };
  // data-title 셀 하나를 필드 하나로 취급하며, 짝이 되는 th는 중복 수집하지 않습니다.
  const fieldIndex = new Map<string, number>();
  root.find("td[data-title]").each((_, element) => {
    const cell = $(element);
    if (cell.closest("[role='dialog']").length && root.is("body")) return;
    if (
      cell
        .closest("table")
        .attr("id")
        ?.match(/grd|grid/i) ||
      cell.is("[col_id]")
    )
      return;
    const label = clean(cell.attr("data-title") || "");
    if (!label) return;
    const value = readValue(cell);
    const previous = fieldIndex.get(label);
    if (previous === undefined) {
      fieldIndex.set(label, fields.length);
      fields.push({ label, value });
    } else if (fields[previous].value === null && value !== null) {
      fields[previous].value = value;
    }
  });
  // data-title이 없는 실제 인접 th/td 쌍에만 대체 추출 방식을 적용합니다.
  root.find("th.w2tb_th").each((_, element) => {
    const th = $(element);
    const next = th.next();
    if (!next.is("td") || next.attr("data-title")) return;
    const label = clean(th.text());
    if (label) fields.push({ label, value: readValue(next) });
  });
  // WebSquare 그리드에서는 행 상태나 체크박스 컨트롤이 아닌 실제 데이터 셀(col_id)만 추출합니다.
  root.find("table").each((_, element) => {
    const table = extractModalGrid($, $(element), readValue);
    if (table) tables.push(table);
  });
  return { title, fields, tables };
}

// 모달 원본 내용을 먼저 수집하고, 의미 해석 및 구조화는 별도 단계에서 수행합니다.
// 제출, 데이터 변경·삭제, 다운로드 링크, 다른 페이지로 이동하는 동작은 탐색하지 않습니다.
const MODAL_SELECTOR =
  '[role="dialog"], dialog[open], [aria-modal="true"], .modal.show, .modal.in, .ui-dialog, .w2ui-popup, .popup-layer, .layer-popup, .layerPopup, [class*="modal"][style*="display: block"]';

const CLICK_SELECTOR =
  'a, button, [role="button"], [onclick], input[type="button"], input[type="image"]';
type DialogSnapshot = {
  id: string;
  title: string | null;
  text: string;
  html: string;
};
type Candidate = {
  index: number;
  id: string;
  tag: string;
  label: string;
  value: string;
  sectionHint: string | null;
  html: string;
  skip: boolean;
};

/**
 * 현재 폼 컨트롤 값을 포함하여 화면에 표시된 모달의 스냅샷을 수집합니다.
 * @param page 모달이 포함된 브라우저 페이지
 * @returns 표시 중인 모달의 식별 정보, 텍스트 및 HTML 스냅샷
 */
async function visibleDialogs(
  page: import("playwright-core").Page,
): Promise<DialogSnapshot[]> {
  return page.locator(MODAL_SELECTOR).evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      const element = node as HTMLElement;
      const style = window.getComputedStyle(element);
      if (
        !element.getClientRects().length ||
        style.visibility === "hidden" ||
        style.display === "none"
      )
        return [];
      if (
        !(element.innerText || "").trim() &&
        !element.querySelector("td[data-title],td[col_id]")
      )
        return [];
      const clone = element.cloneNode(true) as HTMLElement;
      const liveControls = element.querySelectorAll("input,textarea,select");
      const clonedControls = clone.querySelectorAll("input,textarea,select");
      liveControls.forEach((control, index) => {
        const target = clonedControls[index];
        if (!target) return;
        if (
          control instanceof HTMLInputElement &&
          target instanceof HTMLInputElement
        )
          target.setAttribute("value", control.value);
        if (
          control instanceof HTMLTextAreaElement &&
          target instanceof HTMLTextAreaElement
        )
          target.textContent = control.value;
        if (
          control instanceof HTMLSelectElement &&
          target instanceof HTMLSelectElement
        ) {
          Array.from(target.options).forEach(
            (option, i) =>
              (option.selected = control.options[i]?.selected || false),
          );
        }
      });
      return [
        {
          id: element.id,
          title:
            element
              .querySelector(
                "[id$='_header_title'],.w2window_header_title,h1,h2,h3",
              )
              ?.textContent?.trim() || null,
          text: (element.innerText || "").trim(),
          html: clone.outerHTML,
        },
      ];
    }),
  );
}

type ModalWaitResult = {
  status: "settled" | "timeout";
  elapsedMs: number;
  nonemptyValues: number;
};

/**
 * 새로 열린 모달의 값이 일정 시간 동안 변경되지 않을 때까지 기다립니다.
 * 값이 비어 있으면 시간 초과로 기록하며, 값의 안정화가 애플리케이션 로딩 완료를 보장하지는 않습니다.
 * @param page 모달이 포함된 브라우저 페이지
 * @param before 클릭 전에 수집한 표시 중인 모달 목록
 * @param maxWaitMs 새 모달을 관찰할 최대 대기 시간
 * @param quietMs 값의 변경이 없어야 하는 최소 시간
 * @returns 안정화 상태, 경과 시간 및 비어 있지 않은 값의 개수
 */
async function waitForModalDataSettled(
  page: import("playwright-core").Page,
  before: DialogSnapshot[],
  maxWaitMs = 8000,
  quietMs = 1500,
): Promise<ModalWaitResult> {
  const started = Date.now();
  let lastSignature: string | null = null;
  let lastChange = started;
  let nonemptyValues = 0;
  while (Date.now() - started < maxWaitMs) {
    const state = await page.locator(MODAL_SELECTOR).evaluateAll(
      (nodes, oldDialogs) => {
        const visible = nodes.filter((node) => {
          const el = node as HTMLElement;
          const style = getComputedStyle(el);
          return (
            !!el.getClientRects().length &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            (!!(el.innerText || "").trim() ||
              !!el.querySelector("td[data-title],td[col_id]"))
          );
        }) as HTMLElement[];
        const el = visible.find(
          (node) => !oldDialogs.some((old) => old.id === node.id),
        );
        if (!el) return null;
        const values = [
          ...el.querySelectorAll("td[data-title],td[col_id]"),
        ].map((cell) => {
          const controls = [
            ...cell.querySelectorAll(
              "input:not([type=hidden]),textarea,select",
            ),
          ].map((control) => (control as HTMLInputElement).value?.trim() || "");
          const copy = cell.cloneNode(true) as HTMLElement;
          copy
            .querySelectorAll("input,textarea,select,button,script,style")
            .forEach((node) => node.remove());
          return [
            ...controls,
            (copy.innerText || copy.textContent || "").trim(),
          ]
            .filter(Boolean)
            .join(" ");
        });
        return {
          signature: JSON.stringify(values),
          nonemptyValues: values.filter(Boolean).length,
        };
      },
      before.map((item) => ({ id: item.id, text: item.text })),
    );
    if (state) {
      nonemptyValues = state.nonemptyValues;
      if (state.signature !== lastSignature) {
        lastSignature = state.signature;
        lastChange = Date.now();
      } else if (nonemptyValues > 0 && Date.now() - lastChange >= quietMs) {
        return {
          status: "settled",
          elapsedMs: Date.now() - started,
          nonemptyValues,
        };
      }
    }
    await page.waitForTimeout(125);
  }
  return { status: "timeout", elapsedMs: Date.now() - started, nonemptyValues };
}

/**
 * 페이지 또는 지정된 모달에서 위험한 동작을 제외하고 화면에 표시된 조회용 컨트롤을 찾습니다.
 * @param page 탐색할 브라우저 페이지
 * @param dialogId 탐색할 모달 ID. null이면 페이지 본문을 탐색합니다.
 * @returns 탐색 기준 요소 내 인덱스를 포함한 클릭 후보 목록
 */
async function clickCandidates(
  page: import("playwright-core").Page,
  dialogId: string | null,
): Promise<Candidate[]> {
  const root = dialogId
    ? page.locator(`[id=${JSON.stringify(dialogId)}]`)
    : page.locator("body");
  return root.locator(CLICK_SELECTOR).evaluateAll(
    (nodes, { dialogId, modalSelector }) =>
      nodes
        .map((node, index) => {
          const element = node as HTMLElement;
          const owner = element.closest(modalSelector);
          const style = window.getComputedStyle(element);
          const visible =
            !!element.getClientRects().length &&
            style.visibility !== "hidden" &&
            style.display !== "none";
          const value = (
            element.innerText ||
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            (element as HTMLInputElement).value ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          const cell = element.closest("td");
          const th = cell?.previousElementSibling?.matches("th")
            ? cell.previousElementSibling
            : cell?.closest("tr")?.querySelector("th");
          const label = (
            cell?.getAttribute("data-title") ||
            th?.textContent ||
            value
          )
            .replace(/\s+/g, " ")
            .trim();
          const anchor = element.closest("a") as HTMLAnchorElement | null;
          const href = anchor?.getAttribute("href") || "";
          const type = element.getAttribute("type") || "";
          const actionControl =
            element.matches("button,input,[role='button']") && !anchor;
          const inlineAction = [...element.attributes].some((attribute) =>
            /^on/i.test(attribute.name),
          );
          const readOnlyLabel =
            /조회|상세|정보|안내|보기|열기|공지|계획|금액/.test(
              `${label} ${value}`,
            );
          const safeAnchor =
            !anchor ||
            !href ||
            href === "#" ||
            /^javascript:void\((?:null|0)\);?$/i.test(href.trim());
          const sectionHint = (() => {
            const detailRoot = element.closest(".pop_contents > .sub_contents");
            if (!detailRoot) return null;
            for (
              let block: Element | null = element;
              block && block !== detailRoot;
              block = block.parentElement
            ) {
              const headingBlock = block.previousElementSibling;
              if (!headingBlock?.matches(".dfbox")) continue;
              const heading = headingBlock.querySelector(
                ":scope > .fl > .df_tit",
              );
              if (!heading) continue;
              const parent = block.parentElement;
              if (
                !block.matches(".tbbox,.gvwbox") &&
                (!parent ||
                  parent.matches(".pop_contents,.sub_contents") ||
                  parent.querySelectorAll(":scope > .dfbox > .fl > .df_tit")
                    .length !== 1)
              )
                continue;
              return heading.textContent?.trim() || null;
            }
            return null;
          })();
          const skip =
            !visible ||
            !value ||
            (owner?.id || null) !== dialogId ||
            element.hasAttribute("disabled") ||
            element.getAttribute("aria-disabled") === "true" ||
            !!element.closest("nav,header,footer,[id*='navigation']") ||
            !!element.closest("td[data-title='관련공고']") ||
            /^(submit|reset|file)$/i.test(type) ||
            !!anchor?.hasAttribute("download") ||
            !safeAnchor ||
            inlineAction ||
            element.hasAttribute("formaction") ||
            !!anchor?.getAttribute("target") ||
            (actionControl && !readOnlyLabel) ||
            /\.(pdf|hwp|hwpx|docx?|xlsx?|zip)(\?|$)/i.test(href) ||
            /sort|filter|toggle|download|print|close|help|checkbox|selectall/i.test(
              `${element.className} ${element.id}`,
            ) ||
            /^(매뉴얼|온라인 매뉴얼|도움말|목록|이전|다음|저장|등록|수정|삭제|제출|투찰|신청|결제|로그인|로그아웃|인쇄|출력|다운로드|닫기|전체선택|선택해제|오름차순|내림차순)/i.test(
              value,
            ) ||
            /^(확인|처리|실행|승인|확정|취소|변경)(?:\s|$)/.test(value) ||
            /매뉴얼|도움말/.test(label) ||
            (/^(저장|등록|수정|삭제|제출|투찰|신청|결제|취소|확정|승인)/i.test(
              value,
            ) &&
              actionControl);
          return {
            index,
            id: element.id,
            tag: element.tagName.toLowerCase(),
            label,
            value,
            sectionHint,
            html: element.outerHTML.slice(0, 3000),
            skip,
          };
        })
        .filter((candidate) => !candidate.skip),
    { dialogId, modalSelector: MODAL_SELECTOR },
  );
}

/**
 * 페이지의 모달 상태를 유지하면서 클릭 후보와 중첩 모달을 탐색합니다.
 * 개별 클릭 및 모달 종료 실패는 탐색을 중단하지 않고 discovery에 기록합니다.
 * @param page 탐색할 상세 페이지
 * @returns 모달 원본 수집 결과와 탐색 건수 및 실패 내역
 */
export async function collectModalContents(
  page: import("playwright-core").Page,
): Promise<{
  captures: ModalCapture[];
  discovery: NonNullable<ScrapedDetail["modalDiscovery"]>;
}> {
  const captures: ModalCapture[] = [];
  const failures: string[] = [];
  const visited = new Set<string>();
  let candidates = 0;
  let attempted = 0;
  const explore = async (
    dialogId: string | null,
    parentModalTitle: string | null,
    depth: number,
  ): Promise<void> => {
    if (depth > 4 || attempted >= 60) return;
    // 현재 페이지 또는 모달에서 클릭 가능한 후보를 찾습니다.
    const found = await clickCandidates(page, dialogId);
    candidates += found.length;
    const root = dialogId
      ? page.locator(`[id=${JSON.stringify(dialogId)}]`)
      : page.locator("body");
    for (const candidate of found) {
      if (attempted >= 60) break;
      // 동일한 모달 단계에서 각 컨트롤을 한 번만 방문합니다.
      const visitKey = `${dialogId || "page"}:${candidate.id || candidate.index}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const control = root.locator(CLICK_SELECTOR).nth(candidate.index);
      if (!(await control.isVisible().catch(() => false))) continue;
      // 클릭 전 열린 모달과 URL을 기록해 클릭 이후의 상태 변화를 식별합니다.
      const before = await visibleDialogs(page);
      const beforeUrl = page.url();
      attempted++;
      try {
        // 조회용 후보 필터를 통과한 컨트롤에 대해서만 클릭 이벤트를 발생시킵니다.
        // WebSquare의 처리 오버레이가 조회용 컨트롤을 덮을 수 있으므로,
        // 필터 통과 후 이벤트를 직접 발생시켜 오버레이의 클릭 가로채기를 피합니다.
        await control.dispatchEvent("click", undefined, { timeout: 2500 });
        // 새로 열린 모달의 값을 읽기 전에 안정화될 때까지 기다립니다.
        const settling = await waitForModalDataSettled(page, before);
        if (page.url() !== beforeUrl)
          throw new Error("클릭 후 페이지가 이동했습니다.");
        // 클릭 전에는 없었던 새 모달을 식별합니다.
        const after = await visibleDialogs(page);
        const fresh = after.find(
          (item) => !before.some((old) => old.id === item.id),
        );
        if (fresh) {
          // 기존 데이터 저장 기준을 충족하는 모달만 추출하여 저장합니다.
          const structured = extractModalStructure(fresh.html);
          const hasData =
            structured.fields.some((field) => field.value) ||
            structured.tables.some(tableHasValue) ||
            fresh.text.replace(fresh.title || "", "").trim().length > 20;
          if (hasData) {
            captures.push({
              trigger: {
                index: candidate.index,
                tag: candidate.tag,
                label: candidate.label,
                value: candidate.value,
                sectionHint: candidate.sectionHint,
                html: candidate.html,
                parentModalTitle,
              },
              modal: { text: fresh.text, ...structured },
              settling: {
                status: settling.status,
                elapsedMs: settling.elapsedMs,
              },
            });
            // 부모 모달로 돌아가기 전에 수집된 모달 내부의 컨트롤을 탐색합니다.
            if (fresh.id) await explore(fresh.id, fresh.title, depth + 1);
          }
        }
      } catch (error) {
        failures.push(
          `${candidate.index} ${candidate.label.slice(0, 60)} ${candidate.html.slice(0, 200)}: ${error instanceof Error ? error.message.slice(0, 800) : String(error)}`,
        );
      } finally {
        // 클릭으로 열린 모달을 역순으로 닫아 이전 상태로 복원합니다.
        const opened = (await visibleDialogs(page)).filter(
          (item) => !before.some((old) => old.id === item.id),
        );
        for (const item of opened.reverse()) {
          const dialog = item.id
            ? page.locator(`[id=${JSON.stringify(item.id)}]`)
            : page
                .locator(MODAL_SELECTOR)
                .filter({ hasText: item.text })
                .last();
          const close = dialog
            .locator(
              "button.w2window_close,button[aria-label*='닫기'],[data-close]",
            )
            .first();
          try {
            if (await close.isVisible().catch(() => false))
              await close.dispatchEvent("click", undefined, { timeout: 2500 });
            else await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "hidden", timeout: 2500 });
          } catch (error) {
            failures.push(
              `${candidate.label.slice(0, 60)} 모달 복귀 실패: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
            );
          }
        }
      }
    }
  };
  await explore(null, null, 0);
  return {
    captures,
    discovery: {
      candidates,
      attempted,
      captured: captures.length,
      skipped: Math.max(0, candidates - attempted),
      failures,
    },
  };
}
