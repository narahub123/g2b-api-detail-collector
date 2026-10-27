import * as cheerio from "cheerio";
import { traceRisk } from "./risk-trace";
import { extractCommonSections } from "./common-content-extractor";
import { collectAttachments } from "./attachment-collector";
import { collectClickDownloads } from "./attachment-identity";
import { tableHasValue } from "./structured-table";
import { createModalDeduplication } from "./modal-deduplication";
import type { StructuredTable } from "./structured-table";
import { fieldText } from "./field-value";
import { advanceModalPage, collectPaginatedModal, ensureTableIds, ModalPaginationError } from "./modal-pagination";
import type {
  ModalCapture,
  ScrapedDetail,
  StructuredField,
  StructuredSection,
  ClickDownload,
  ModalTriggerStep,
} from "./detail-page";

// 기존 터미널·파일 로그 대신 통합 추적에 기록합니다.
// 탐색의 상태를 읽기만 하며 클릭이나 수집 결과는 변경하지 않습니다.
let modalTraceSequence = 0;
function recordModalTrace(event: string, details: Record<string, unknown>): void {
  traceRisk("modal-exploration", event, details);
}

// 선택 페이지의 원본 DOM 상태를 보존합니다. 특정 페이저 구현을 추측해 숫자로 확정하지 않습니다.
// 추적만을 위한 읽기 작업으로, 페이지 전환이나 클릭 이벤트는 발생시키지 않습니다.
async function inspectModalPager(
  page: import("playwright-core").Page,
  dialogId: string | null,
  tableId: string | null,
): Promise<Record<string, unknown>> {
  try {
    return await page.evaluate(({ dialogId, tableId }) => {
      const root = dialogId ? document.getElementById(dialogId) : document.body;
      if (!root) return { rootFound: false };
      const table = tableId ? document.getElementById(tableId) : null;
      const scope = table?.parentElement?.parentElement || root;
      const controls = [...scope.querySelectorAll("[aria-current], [aria-selected], .selected, .on, .active, [class*='paging'] a, [class*='paging'] button, [class*='pagination'] a, [class*='pagination'] button")]
        .filter((node) => {
          const el = node as HTMLElement;
          return !!el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
        })
        .slice(0, 25)
        .map((node) => ({
          tag: node.tagName.toLowerCase(),
          id: (node as HTMLElement).id,
          text: (node.textContent || "").trim().slice(0, 40),
          className: typeof (node as HTMLElement).className === "string" ? (node as HTMLElement).className.slice(0, 120) : "",
          ariaCurrent: node.getAttribute("aria-current"),
          ariaSelected: node.getAttribute("aria-selected"),
        }));
      return { rootFound: true, tableFound: !!table, controls };
    }, { dialogId, tableId });
  } catch (error) {
    return { inspectError: error instanceof Error ? error.message : String(error) };
  }
}

// 화면 텍스트 비교와 필드 레이블 추출에 사용할 공백 정규화 함수입니다.
const clean = (value: string) => value.replace(/\s+/g, " ").trim();
// 공백만 있는 값은 데이터가 없는 상태(null)로 취급합니다.
const nonempty = (value: string): string | null => clean(value) || null;

/**
 * 실시간 폼 값이 반영된 모달 HTML 스냅샷에서 필드와 그리드를 추출합니다.
 * G2B WebSquare는 필드에 td[data-title], 그리드 데이터에 col_id를 사용하며,
 * 그리드 헤더는 필드 레이블로 취급하지 않습니다.
 * @param html 열린 모달의 HTML 스냅샷
 * @param baseUrl 상대 파일 링크를 해석할 현재 페이지 URL
 * @param attachmentOptions 파일 식별자와 저장할 모달 순서
 * @returns 모달 제목, 섹션, 필드, 표 및 확인된 첨부 URL
 */
export function extractModalStructure(html: string, baseUrl?: string,
  attachmentOptions: { noticeKey?: string; clickDownloads?: ClickDownload[]; modalIndex?: number } = {}): {
  title: string | null;
  sections: StructuredSection[];
  fields: StructuredField[];
  tables: StructuredTable[];
  attachments: { name: string; url: string }[];
} {
  const $ = cheerio.load(html);
  const root = $("[role='dialog']").first().length ? $("[role='dialog']").first() : $("body");
  const title = nonempty(root.find("[id$='_header_title'],.w2window_header_title,h1,h2,h3").first().text());
  const sections = extractCommonSections(html, "modal");
  const attachments = collectAttachments(html, { baseUrl, includeOtherLinks: true, ...attachmentOptions })
    .filter((item): item is { name: string; url: string } => Boolean(item.url));
  return { title, sections, fields: sections.flatMap((section) => section.fields),
    tables: sections.flatMap((section) => section.tables), attachments };
}
// 모달 원본 내용을 먼저 수집하고, 의미 해석 및 구조화는 별도 단계에서 수행합니다.
// 제출, 데이터 변경·삭제, 다운로드 링크, 다른 페이지로 이동하는 동작은 탐색하지 않습니다.
// 여러 UI 구현 방식에서 표시되는 모달을 공통으로 찾기 위한 선택자입니다.
const MODAL_SELECTOR =
  '[role="dialog"], dialog[open], [aria-modal="true"], .modal.show, .modal.in, .ui-dialog, .w2ui-popup, .popup-layer, .layer-popup, .layerPopup, [class*="modal"][style*="display: block"]';

// 모달을 열 가능성이 있는 클릭 요소를 폭넓게 찾고, 실제 제외 여부는 후보 검사에서 결정합니다.
const CLICK_SELECTOR =
  'a, button, [role="button"], [onclick], input[type="button"], input[type="image"]';
type DialogSnapshot = {
  id: string;
  title: string | null;
  text: string;
  html: string;
};
/**
 * WebSquare는 중첩 팝업을 열 때 상위 프레임 경로를 ID 앞에 계속 붙입니다.
 * 따라서 전체 ID가 아니라 마지막 프레임의 화면 식별자를 비교해야
 * A → B → A 형태로 같은 화면이 다시 열리는 순환을 감지할 수 있습니다.
 * 화면 식별자를 확인할 수 없는 경우에는 제목만으로 서로 다른 화면을 차단하지 않습니다.
 */
function modalScreenKey(dialogId: string, title: string | null): string | null {
  const lastFrame = dialogId.split("_wframe_").at(-1) || dialogId;
  const screen = lastFrame.replace(/^popupCnts_/, "").replace(/^mainWframe_/, "");
  if (!screen || screen === dialogId && !dialogId.includes("mainWframe_")) return null;
  const normalizedTitle = (title || "").replace(/\s+/g, " ").trim();
  return `${screen}::${normalizedTitle}`;
}

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
      // cloneNode만으로 반영되지 않을 수 있는 현재 폼 값을 복제본 HTML에 옮깁니다.
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
  // 데이터 셀의 값 목록을 직렬화해 변경이 멈췄는지 비교합니다.
  // 비어 있지 않은 값이 일정 시간 유지될 때만 안정화로 판단합니다.
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
        // 클릭 전에 없었던 모달만 안정화 관찰 대상으로 삼습니다.
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
  // dialogId가 있으면 해당 모달 내부만, 없으면 페이지 본문을 후보 검색 범위로 삼습니다.
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
          // 클릭 요소에 표시되는 텍스트를 우선 사용하고, 없으면 접근성 레이블·title·input 값을 사용합니다.
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
          // 필드의 data-title 또는 인접 th를 우선하여 클릭 요소가 속한 항목명을 기록합니다.
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
          // 변경 동작으로 추정되는 버튼형 요소를 구별할 때 사용합니다(링크는 제외).
          const actionControl =
            element.matches("button,input,[role='button']") && !anchor;
          // onclick 등 on* 속성을 가진 요소는 동작을 예측하기 어려워 제외합니다.
          const inlineAction = [...element.attributes].some((attribute) =>
            /^on/i.test(attribute.name),
          );
          const safeAnchor =
            !anchor ||
            !href ||
            href === "#" ||
            /^javascript:void\((?:null|0)\);?$/i.test(href.trim());
          // 클릭 요소가 속한 상세 섹션 제목을 찾아 수집 출처 정보로 남깁니다.
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
          // 클릭 후보 제외 목록(차단 목록)입니다. 아래 조건 중 하나라도 참이면 skip=true입니다.
          // 클릭할 요소를 특정 '조회' 키워드로 허용하는 방식은 아니지만,
          // class/id·화면 문구·레이블의 키워드로 일부 요소를 제외하는 방식은 유지합니다.
          // 따라서 키워드가 실제 조회 기능의 요소와 겹치면 해당 요소도 제외될 수 있습니다.
          const skip =
            // 화면에서 보이지 않거나 표시 문구가 없는 요소는 클릭하지 않습니다.
            !visible ||
            !value ||
            // 탐색 중인 모달 범위 밖의 요소는 제외합니다. 본문 탐색 시 모달 내부 요소도 제외합니다.
            (owner?.id || null) !== dialogId ||
            // 비활성 요소 및 공통 내비게이션 영역은 탐색하지 않습니다.
            element.hasAttribute("disabled") ||
            element.getAttribute("aria-disabled") === "true" ||
            !!element.closest("nav,header,footer,[id*='navigation']") ||
            // 관련공고 셀 내부 컨트롤은 이 탐색의 대상에서 제외합니다.
            !!element.closest("td[data-title='관련공고']") ||
            // 폼 제출·초기화·파일 입력 및 다운로드 속성이 있는 요소를 제외합니다.
            /^(submit|reset|file)$/i.test(type) ||
            !!anchor?.hasAttribute("download") ||
            // 외부 주소로 이동할 수 있는 링크, 인라인 이벤트, 폼 액션, 새 창 링크는 제외합니다.
            // safeAnchor는 href가 없거나 #, javascript:void(0/null)인 경우에만 참입니다.
            !safeAnchor ||
            inlineAction ||
            element.hasAttribute("formaction") ||
            !!anchor?.getAttribute("target") ||
            // href가 지정된 파일 확장자로 끝나면 파일 열기·다운로드 가능성이 있어 제외합니다.
            /\.(pdf|hwp|hwpx|docx?|xlsx?|zip)(\?|$)/i.test(href) ||
            // 요소의 className 또는 id에 정렬·필터·접기·출력·닫기 등 기능명 키워드가 있으면 제외합니다.
            // 여기의 영어 키워드는 화면 표시 문구가 아니라 HTML 속성 이름을 검사합니다.
            /sort|filter|toggle|download|print|close|help|checkbox|selectall/i.test(
              `${element.className} ${element.id}`,
            ) ||
            // 화면 표시 문구(value)가 아래 단어로 시작하면 조회 외 동작으로 보고 제외합니다.
            // ^는 문구의 시작 위치를 뜻하며, 뒤에 다른 글자가 붙어도 일치할 수 있습니다.
            /^(매뉴얼|온라인 매뉴얼|도움말|목록|이전|다음|저장|등록|수정|삭제|제출|투찰|신청|결제|로그인|로그아웃|인쇄|출력|다운로드|닫기|전체선택|선택해제|오름차순|내림차순)/i.test(
              value,
            ) ||
            // 확인·처리·승인 등의 문구가 독립 단어(뒤가 공백 또는 끝)로 시작하면 제외합니다.
            /^(확인|처리|실행|승인|확정|취소|변경)(?:\s|$)/.test(value) ||
            // 요소 자체의 문구와 별개로 필드 레이블(label)에 도움말 관련 단어가 있어도 제외합니다.
            /매뉴얼|도움말/.test(label) ||
            // 변경·제출 계열 문구로 시작하면서 버튼·input·role=button이면 제외합니다.
            // 링크 여부까지 함께 확인한 actionControl 조건이므로 앞의 value 검사와 범위가 다릅니다.
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
        // 위 제외 조건을 하나도 충족하지 않은 요소만 실제 클릭 후보로 반환합니다.
        .filter((candidate) => !candidate.skip),
    { dialogId, modalSelector: MODAL_SELECTOR },
  );
}

/**
 * 페이지의 모달 상태를 유지하면서 클릭 후보와 중첩 모달을 탐색합니다.
 * 개별 클릭 및 모달 종료 실패는 탐색을 중단하지 않고 discovery에 기록합니다.
 * @param page 탐색할 상세 페이지
 * @param noticeKey 공고번호와 차수로 만든 첨부 다운로드 키
 * @returns 모달 원본 수집 결과와 탐색 건수 및 실패 내역
 */
export async function collectModalContents(
  page: import("playwright-core").Page,
  noticeKey?: string,
): Promise<{
  captures: ModalCapture[];
  discovery: NonNullable<ScrapedDetail["modalDiscovery"]>;
  sections: StructuredSection[];
}> {
  // captures에는 저장 기준을 통과한 모달만 담고, failures에는 개별 탐색 오류를 누적합니다.
  const traceRunId = ++modalTraceSequence;
  recordModalTrace("collection-start", { traceRunId, url: page.url() });
  const captures: ModalCapture[] = [];
  const failures: string[] = [];
  // 같은 모달 단계의 클릭 요소를 반복 시도하지 않기 위한 방문 기록입니다.
  const visited = new Set<string>();
  const attemptsByView = new Map<string, number>();
  // 수집 실행별로 중복 검사 상태를 독립적으로 관리합니다.
  const modalDeduplication = createModalDeduplication();
  let candidates = 0;
  let attempted = 0;
  // 페이지에서 시작해 새로 열린 모달의 내부 클릭 요소까지 깊이 우선으로 탐색합니다.
  const explore = async (
    dialogId: string | null,
    parentModalTitle: string | null,
    depth: number,
    path: ModalTriggerStep[],
    pageNumber = 1,
    pageTableId: string | null = null,
    ancestorScreens: readonly string[] = [],
  ): Promise<void> => {
    // 같은 화면의 클릭 시도만 제한하여 페이지 수가 많은 표의 하위 상세를 빠뜨리지 않습니다.
    if (depth > 4) return;
    const viewKey = `${dialogId || "page"}:${pageTableId || "first"}:${pageNumber}`;
    if ((attemptsByView.get(viewKey) || 0) >= 1000)
      throw new ModalPaginationError("한 화면의 조회 버튼 탐색 한도를 초과했습니다.");
    // 현재 페이지 또는 모달에서 클릭 가능한 후보를 찾습니다.
    recordModalTrace("explore-start", { traceRunId, dialogId, depth, pageNumber, pageTableId,
      pager: await inspectModalPager(page, dialogId, pageTableId) });
    const found = await clickCandidates(page, dialogId);
    candidates += found.length;
    const root = dialogId
      ? page.locator(`[id=${JSON.stringify(dialogId)}]`)
      : page.locator("body");
    for (const candidate of found) {
      if ((attemptsByView.get(viewKey) || 0) >= 1000)
        throw new ModalPaginationError("한 화면의 조회 버튼 탐색 한도를 초과했습니다.");
      // 동일한 모달 단계에서 각 컨트롤을 한 번만 방문합니다.
      const visitKey = `${dialogId || "page"}:${pageTableId || "first"}:${pageNumber}:${candidate.id || candidate.index}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      const control = root.locator(CLICK_SELECTOR).nth(candidate.index);
      if (!(await control.isVisible().catch(() => false))) continue;
      // 클릭 전 열린 모달과 URL을 기록해 클릭 이후의 상태 변화를 식별합니다.
      const before = await visibleDialogs(page);
      const beforeUrl = page.url();
      attempted++;
      attemptsByView.set(viewKey, (attemptsByView.get(viewKey) || 0) + 1);
      recordModalTrace("candidate-before-click", { traceRunId, dialogId, depth, pageNumber, pageTableId,
        candidate: { id: candidate.id, index: candidate.index, label: candidate.label, value: candidate.value },
        dialogs: before.map((item) => ({ id: item.id, title: item.title })),
        pager: await inspectModalPager(page, dialogId, pageTableId) });
      try {
        // 조회용 후보 필터를 통과한 컨트롤에 대해서만 클릭 이벤트를 발생시킵니다.
        // WebSquare의 처리 오버레이가 조회용 컨트롤을 덮을 수 있으므로,
        // 필터 통과 후 이벤트를 직접 발생시켜 오버레이의 클릭 가로채기를 피합니다.
        await control.dispatchEvent("click", undefined, { timeout: 2500 });
        recordModalTrace("candidate-after-click", { traceRunId, dialogId, depth, pageNumber, pageTableId,
          candidateId: candidate.id, candidateIndex: candidate.index,
          pager: await inspectModalPager(page, dialogId, pageTableId) });
        // 새로 열린 모달의 값을 읽기 전에 안정화될 때까지 기다립니다.
        const settling = await waitForModalDataSettled(page, before);
        if (page.url() !== beforeUrl)
          throw new Error("클릭 후 페이지가 이동했습니다.");
        // 클릭 전에는 없었던 새 모달을 식별합니다.
        const after = await visibleDialogs(page);
        recordModalTrace("candidate-after-settle", { traceRunId, dialogId, depth, pageNumber, pageTableId,
          candidateId: candidate.id, candidateIndex: candidate.index,
          settling, dialogs: after.map((item) => ({ id: item.id, title: item.title })),
          pager: await inspectModalPager(page, dialogId, pageTableId) });
        const fresh = after.find(
          (item) => !before.some((old) => old.id === item.id),
        );
        if (fresh) {
          // 모달 HTML을 구조화하고, 실제 저장할 만한 데이터가 있는지 기존 기준으로 판단합니다.
          const currentPath = [...path, { id: candidate.id, index: candidate.index,
            label: candidate.label, value: candidate.value }];
          const modalIndex = captures.length;
          const clickDownloads = fresh.id
            ? await collectClickDownloads(page, page.locator(`[id=${JSON.stringify(fresh.id)}]`)) : [];
          const structured = extractModalStructure(fresh.html, page.url(),
            { noticeKey, clickDownloads, modalIndex });
          // 필드 값, 테이블 값 또는 제목 외의 충분한 본문 텍스트 중 하나가 있으면 저장 대상입니다.
          // 필드 값·테이블 값이 하나라도 있거나 제목을 뺀 본문이 20자를 넘으면 저장할 데이터가 있다고 봅니다.
          // 이 기준은 저장 여부 판단용이며 하위 탐색을 막는 조건으로 사용하지 않습니다.
          const hasData =
            structured.fields.some((field) => Boolean(fieldText(field.value))) ||
            structured.tables.some(tableHasValue) ||
            fresh.text.replace(fresh.title || "", "").trim().length > 20;
          // 저장 여부와 무관하게 동일한 모달 내용인지 한 번만 확인합니다.
          const isDuplicate = modalDeduplication.isDuplicate({
            text: fresh.text,
            ...structured,
          });
          // 데이터가 있고 처음 확인한 내용인 모달만 결과에 저장합니다.
          // 저장 여부와 하위 모달 탐색 여부는 별도의 조건으로 판단합니다.
          // 내용이 있고 중복되지 않은 모달만 captures에 추가합니다.
          // trigger는 어떤 요소를 눌러 열었는지, settling은 값 안정화 대기 결과를 기록합니다.
          let savedCapture: ModalCapture | null = null;
          if (hasData && !isDuplicate) {
            // 모달 내용과 함께 어떤 클릭 요소에서 열렸는지 및 값 안정화 결과를 기록합니다.
            savedCapture = {
              trigger: {
                index: candidate.index,
                tag: candidate.tag,
                label: candidate.label,
                value: candidate.value,
                sectionHint: candidate.sectionHint,
                html: candidate.html,
                parentModalTitle,
                path: currentPath,
              },
              modal: { text: fresh.text, title: structured.title, sections: structured.sections,
                attachments: structured.attachments },
              settling: {
                status: settling.status,
                elapsedMs: settling.elapsedMs,
              },
            };
            captures.push(savedCapture);
          }
          // 저장할 데이터가 없는 모달도 id가 있고 중복되지 않으면 내부 클릭 후보를 탐색합니다.
          // 데이터 저장 여부와 독립적으로 새로운 모달의 하위 컨트롤을 탐색합니다.
          // 이미 확인한 동일 내용의 모달은 다시 탐색하지 않습니다.
          // 같은 화면이 현재 조상 탐색 경로에 이미 존재한다면 하위 재귀만 중단합니다.
          // 열린 모달의 데이터 저장과 finally의 모달 닫기는 그대로 수행합니다.
          // 전역 방문 집합이 아닌 조상 경로를 사용하므로 다른 행에서 같은 유형의
          // 상세 모달을 정상적으로 다시 열어 수집하는 동작은 유지됩니다.
          const screenKey = fresh.id ? modalScreenKey(fresh.id, fresh.title) : null;
          const isCircularScreen = screenKey !== null && ancestorScreens.includes(screenKey);
          // 동일 화면의 재진입과 다른 경로를 통한 재수집을 구분해 기록합니다.
          recordModalTrace("dedup-decision", { traceRunId, depth, screenKey, ancestorScreens, isCircularScreen, isDuplicate, freshDialogId: fresh.id, parentDialogId: dialogId, pageNumber, pageTableId });
          if (isCircularScreen) {
            recordModalTrace("circular-screen-skipped", {
              traceRunId, dialogId, depth, pageNumber, pageTableId,
              freshDialogId: fresh.id, freshTitle: fresh.title,
              screenKey, ancestorScreens,
            });
          }
          if (fresh.id && !isDuplicate && !isCircularScreen) {
            recordModalTrace("nested-pagination-start", { traceRunId, parentDialogId: dialogId,
              parentPageNumber: pageNumber, parentTableId: pageTableId, freshDialogId: fresh.id,
              pager: await inspectModalPager(page, dialogId, pageTableId) });
            const collected = await collectPaginatedModal(page, fresh.id, page.url(), {
              onPage: async (number, tableId, rowOffset) => {
                recordModalTrace("nested-onpage-before", { traceRunId, dialogId: fresh.id, number, tableId,
                  parentDialogId: dialogId, parentPageNumber: pageNumber, parentTableId: pageTableId,
                  pager: await inspectModalPager(page, fresh.id, tableId) });
                const pagePath: ModalTriggerStep[] = number === 1 ? currentPath : [...currentPath,
                  { id: tableId || "", index: -1, label: "페이지", value: String(number), page: number, rowOffset }];
                if (savedCapture) {
                  const snapshot = (await visibleDialogs(page)).find((item) => item.id === fresh.id);
                  if (snapshot) {
                    const downloads = await collectClickDownloads(page, page.locator(`[id=${JSON.stringify(fresh.id)}]`));
                    const attachments = extractModalStructure(snapshot.html, page.url(),
                      { noticeKey, clickDownloads: downloads, modalIndex }).attachments;
                    for (const attachment of attachments) {
                      if (!savedCapture.modal.attachments?.some((item) => item.url === attachment.url))
                        (savedCapture.modal.attachments ||= []).push(attachment);
                      if (attachment.url.includes("&modal=") &&
                        !savedCapture.modal.attachmentSources?.some((item) => item.url === attachment.url))
                        (savedCapture.modal.attachmentSources ||= []).push({ url: attachment.url, path: pagePath });
                    }
                  }
                }
                await explore(fresh.id, fresh.title, depth + 1, pagePath, number, tableId,
                  screenKey ? [...ancestorScreens, screenKey] : ancestorScreens);
                recordModalTrace("nested-onpage-after", { traceRunId, dialogId: fresh.id, number, tableId,
                  pager: await inspectModalPager(page, fresh.id, tableId) });
              },
            });
            recordModalTrace("nested-pagination-complete", { traceRunId, freshDialogId: fresh.id,
              parentDialogId: dialogId, parentPageNumber: pageNumber, parentTableId: pageTableId,
              pager: await inspectModalPager(page, dialogId, pageTableId) });
            if (savedCapture) savedCapture.modal.sections = collected.sections;
          }
        }
      } catch (error) {
        recordModalTrace("candidate-error", { traceRunId, dialogId, depth, pageNumber, pageTableId,
          candidateId: candidate.id, candidateIndex: candidate.index,
          error: error instanceof Error ? error.message : String(error),
          pager: await inspectModalPager(page, dialogId, pageTableId) });
        if (error instanceof ModalPaginationError) throw error;
        // 개별 후보의 오류는 기록하고 나머지 후보 탐색을 계속합니다.
        failures.push(
          `${candidate.index} ${candidate.label.slice(0, 60)} ${candidate.html.slice(0, 200)}: ${error instanceof Error ? error.message.slice(0, 800) : String(error)}`,
        );
      } finally {
        // 클릭으로 열린 모달을 역순으로 닫아 이전 상태로 복원합니다.
        recordModalTrace("candidate-before-close", { traceRunId, dialogId, depth, pageNumber, pageTableId,
          candidateId: candidate.id, candidateIndex: candidate.index,
          pager: await inspectModalPager(page, dialogId, pageTableId) });
        const opened = (await visibleDialogs(page)).filter(
          (item) => !before.some((old) => old.id === item.id),
        );
        for (const item of opened.reverse()) {
          recordModalTrace("dialog-close-start", { traceRunId, dialogId, depth, pageNumber, pageTableId,
            closingDialogId: item.id, pager: await inspectModalPager(page, dialogId, pageTableId) });
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
            recordModalTrace("dialog-close-complete", { traceRunId, dialogId, depth, pageNumber, pageTableId,
              closingDialogId: item.id, pager: await inspectModalPager(page, dialogId, pageTableId) });
          } catch (error) {
            failures.push(
              `${candidate.label.slice(0, 60)} 모달 복귀 실패: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`,
            );
          }
        }
        recordModalTrace("candidate-after-close", { traceRunId, dialogId, depth, pageNumber, pageTableId,
          candidateId: candidate.id, candidateIndex: candidate.index,
          pager: await inspectModalPager(page, dialogId, pageTableId) });
      }
    }
    recordModalTrace("explore-complete", { traceRunId, dialogId, depth, pageNumber, pageTableId,
      pager: await inspectModalPager(page, dialogId, pageTableId) });
  };
  // 최상위 페이지부터 시작하고, 저장 결과와 탐색 통계를 함께 반환합니다.
  // 페이지 본문에서 시작하여 새 모달을 발견할 때마다 재귀적으로 하위 후보를 탐색합니다.
  const paginatedPage = await collectPaginatedModal(page, null, page.url(), {
    onPage: async (number, tableId, rowOffset) => {
      recordModalTrace("root-onpage-before", { traceRunId, number, tableId,
        pager: await inspectModalPager(page, null, tableId) });
      const path: ModalTriggerStep[] = number === 1 ? [] :
        [{ id: tableId || "", index: -1, label: "페이지", value: String(number), page: number, rowOffset }];
      await explore(null, null, 0, path, number, tableId);
      recordModalTrace("root-onpage-after", { traceRunId, number, tableId,
        pager: await inspectModalPager(page, null, tableId) });
    },
  });
  recordModalTrace("collection-complete", { traceRunId, captures: captures.length,
    candidates, attempted, failures: failures.length });
  return {
    captures,
    sections: paginatedPage.sections,
    discovery: {
      candidates,
      attempted,
      captured: captures.length,
      // skipped는 수집한 후보 수에서 실제 클릭 시도 수를 뺀 통계이며 개별 제외 사유의 건수는 아닙니다.
      skipped: Math.max(0, candidates - attempted),
      failures,
    },
  };
}

/** 저장된 조회 경로를 다시 열어 첨부파일이 들어 있는 모달을 찾습니다. */
export async function replayModalPath(page: import("playwright-core").Page,
  path: ModalTriggerStep[]): Promise<import("playwright-core").Locator> {
  if (!path.length || path.length > 9) throw new Error("모달 경로가 올바르지 않습니다.");
  await ensureTableIds(page, null);
  let dialogId: string | null = null;
  for (const step of path) {
    if (step.page !== undefined) {
      if (!step.id || !Number.isSafeInteger(step.page) || step.page < 2)
        throw new Error("모달 페이지 경로가 올바르지 않습니다.");
      await ensureTableIds(page, dialogId);
      for (let number = 1; number < step.page; number++) await advanceModalPage(page, dialogId, step.id);
      continue;
    }
    const candidates = await clickCandidates(page, dialogId);
    const candidate = candidates.find((item) => item.index === step.index && item.id === step.id &&
      item.label === step.label && item.value === step.value);
    if (!candidate) throw new Error("저장된 모달 열기 요소를 찾을 수 없습니다.");
    const before = await visibleDialogs(page);
    const root = dialogId ? page.locator(`[id=${JSON.stringify(dialogId)}]`) : page.locator("body");
    await root.locator(CLICK_SELECTOR).nth(step.index).dispatchEvent("click", undefined, { timeout: 2500 });
    await waitForModalDataSettled(page, before);
    const fresh = (await visibleDialogs(page)).find((item) => !before.some((old) => old.id === item.id));
    if (!fresh?.id) throw new Error("첨부파일 모달을 열 수 없습니다.");
    dialogId = fresh.id;
  }
  return page.locator(`[id=${JSON.stringify(dialogId)}]`);
}
