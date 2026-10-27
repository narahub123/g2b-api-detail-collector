import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCommonSections } from "./common-content-extractor";
import type { StructuredSection } from "./detail-page";
import type { StructuredTable } from "./structured-table";
import type { Page } from "playwright-core";

export class ModalPaginationError extends Error {}
const scopeSelector = (dialogId: string | null) =>
  dialogId ? `[id=${JSON.stringify(dialogId)}]` : "body";

/** 원본 ID가 없는 표에도 재접속 시 재현 가능한 식별자를 부여합니다. */
export async function ensureTableIds(
  page: Page,
  dialogId: string | null,
): Promise<void> {
  await page.locator(scopeSelector(dialogId)).evaluate((root) => {
    root.querySelectorAll("table").forEach((table, index) => {
      if (table.id) return;
      const base = `g2b_collector_table_${index}`;
      let candidate = base;
      let suffix = 1;
      while (document.getElementById(candidate))
        candidate = `${base}_${suffix++}`;
      table.id = candidate;
    });
  });
}

/** 현재 모달의 입력값까지 반영한 HTML을 읽습니다. */
async function modalHtml(page: Page, dialogId: string | null): Promise<string> {
  return page.locator(scopeSelector(dialogId)).evaluate((node, dialogId) => {
    const clone = node.cloneNode(true) as HTMLElement;
    if (!dialogId)
      clone
        .querySelectorAll('[role="dialog"],dialog,[aria-modal="true"]')
        .forEach((item) => item.remove());
    const controls = node.querySelectorAll("input,textarea,select");
    const copied = clone.querySelectorAll("input,textarea,select");
    controls.forEach((control, index) => {
      const target = copied[index];
      if (target && "value" in control)
        target.setAttribute("value", (control as HTMLInputElement).value);
    });
    return clone.outerHTML;
  }, dialogId);
}

/** 표와 같은 영역에 있는 전체 건수 및 다음 버튼을 찾습니다. */
async function gridPager(page: Page, dialogId: string | null, tableId: string) {
  return page.locator(scopeSelector(dialogId)).evaluate((root, tableId) => {
    const table = document.getElementById(tableId);
    if (!table || !root.contains(table)) return null;
    const controls = [
      ...root.querySelectorAll("a,button,[role='button'],input[type='button']"),
    ];
    let missing: {
      total: number;
      nextIndex: number;
      enabled: boolean;
      pageListId?: string | null;
      selectedPage?: number;
    } | null = null;
    for (
      let container = table.parentElement;
      container && root.contains(container);
      container = container.parentElement
    ) {
      const button = controls.find((node) => {
        if (!container.contains(node)) return false;
        const element = node as HTMLElement;
        const label = (
          element.innerText ||
          element.getAttribute("aria-label") ||
          element.getAttribute("title") ||
          (element as HTMLInputElement).value ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
        const context = `${element.id} ${element.className} ${element.parentElement?.id || ""} ${element.parentElement?.className || ""}`;
        return (
          !!element.getClientRects().length &&
          getComputedStyle(element).visibility !== "hidden" &&
          (/^(?:다음|next|>|›|»|→)$/i.test(label) || /next/i.test(context)) &&
          (/page|paging|pagin/i.test(context) || /^(?:다음|next)$/i.test(label))
        );
      });
      const tableCount = container.querySelectorAll("table").length;
      if (
        button &&
        (tableCount <= 3 || container.classList.contains("gvwbox"))
      ) {
        let total = 0;
        for (
          let owner: Element | null = container;
          owner && root.contains(owner);
          owner = owner.parentElement
        ) {
          total = Number(
            /전체\s*([\d,]+)\s*건/
              .exec((owner as HTMLElement).innerText || "")?.[1]
              ?.replaceAll(",", "") || 0,
          );
          if (total) break;
        }
        if (total) {
          const pageList = button.closest(".w2pageList");
          const selected = pageList?.querySelector(
            "a.w2pageList_label_selected[index]",
          );
          return {
            total,
            nextIndex: controls.indexOf(button),
            enabled: !(button as HTMLElement).matches(
              ":disabled,[aria-disabled='true']",
            ),
            pageListId: pageList?.id || null,
            selectedPage: Number(selected?.getAttribute("index") || 0),
          };
        }
      }
      const total = Number(
        /전체\s*([\d,]+)\s*건/
          .exec((container as HTMLElement).innerText || "")?.[1]
          ?.replaceAll(",", "") || 0,
      );
      if (!missing && total && tableCount === 1)
        missing = { total, nextIndex: -1, enabled: false };
    }
    return missing;
  }, tableId);
}

/** 페이지 수집 실패를 재현하지 않고도 원인을 추적하기 위해 남기는 최소 상태 정보입니다. */
type PaginationDiagnostic = {
  tableId: string;
  pageNumber: number;
  totalPages: number;
  collectedRows: number;
  totalRows: number;
  stage: string;
  startedAt: number;
  expectedRows?: number;
  extractedRows?: number;
  visibleRows?: number;
  selectedPage?: number;
  firstRowNumber?: string;
};

/** 진행 로그는 서버 터미널에 남기며, 페이지 번호·누적 행 수·단계·소요 시간을 함께 표시합니다. */
function logPagination(d: PaginationDiagnostic, message: string): void {
  console.info(
    `[g2b-pagination] table=${d.tableId} page=${d.pageNumber}/${d.totalPages} ` +
      `rows=${d.collectedRows}/${d.totalRows} stage=${d.stage} elapsedMs=${Date.now() - d.startedAt} ${message}`,
  );
}

/** 실패 시 해당 표와 페이지 버튼의 실제 DOM 상태를 별도 파일로 남깁니다. */
async function capturePaginationFailure(
  page: Page,
  dialogId: string | null,
  diagnostic: PaginationDiagnostic,
  error: unknown,
): Promise<string> {
  // 원본 예외 메시지는 보존합니다. 스냅샷 저장에 실패해도 수집 오류 자체는 덮어쓰지 않습니다.
  const reason = error instanceof Error ? error.message : String(error);
  let snapshotPath = "저장 실패";
  try {
    // 실패한 시점의 실제 DOM을 읽습니다. 재조회나 페이지 이동을 수행하지 않습니다.
    const snapshot = await page
      .locator(scopeSelector(dialogId))
      .evaluate((root, tableId) => {
        const table = document.getElementById(tableId);
        const pageList =
          table?.closest(".gvwbox")?.querySelector(".w2pageList") ??
          [...root.querySelectorAll(".w2pageList")].find((node) =>
            node.id.includes("pageList"),
          );
        const selected = pageList?.querySelector(
          "a.w2pageList_label_selected[index]",
        );
        const rows = table ? [...table.querySelectorAll("tbody tr")] : [];
        // WebSquare는 마지막 페이지에도 숨겨진 행을 DOM에 남길 수 있으므로 표시 행을 따로 셉니다.
        const visible = rows.filter((row) => {
          const style = getComputedStyle(row);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            row.getClientRects().length > 0
          );
        });
        return {
          selectedPage: Number(selected?.getAttribute("index") || 0),
          domRows: rows.length,
          visibleRows: visible.length,
          firstRowNumber:
            visible[0]?.querySelector("td")?.textContent?.trim() || "",
          tableHtml: table?.outerHTML || null,
          pagerHtml: pageList?.outerHTML || null,
        };
      }, diagnostic.tableId);
    diagnostic.selectedPage = snapshot.selectedPage;
    diagnostic.visibleRows = snapshot.visibleRows;
    diagnostic.firstRowNumber = snapshot.firstRowNumber;
    const name = `g2b-pagination-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    // 수집 결과/DB와 분리된 OS 임시 디렉터리에만 진단 자료를 기록합니다.
    snapshotPath = join(tmpdir(), name);
    await writeFile(
      snapshotPath,
      JSON.stringify(
        {
          ...diagnostic,
          elapsedMs: Date.now() - diagnostic.startedAt,
          error: reason,
          snapshot,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (captureError) {
    console.error("[g2b-pagination] 진단 스냅샷 저장 실패", captureError);
  }
  const details =
    `table=${diagnostic.tableId}, page=${diagnostic.pageNumber}/${diagnostic.totalPages}, ` +
    `stage=${diagnostic.stage}, rows=${diagnostic.collectedRows}/${diagnostic.totalRows}, ` +
    `expected=${diagnostic.expectedRows ?? "unknown"}, extracted=${diagnostic.extractedRows ?? "unknown"}, ` +
    `visible=${diagnostic.visibleRows ?? "unknown"}, selected=${diagnostic.selectedPage ?? "unknown"}, ` +
    `firstRowNo=${diagnostic.firstRowNumber ?? "unknown"}, ` +
    `elapsedMs=${Date.now() - diagnostic.startedAt}, snapshot=${snapshotPath}`;
  console.error(`[g2b-pagination] 실패: ${details}`, reason);
  return details;
}

/** 다음 페이지를 누르고 실제 표 내용이 바뀔 때까지 기다립니다. */
export async function advanceModalPage(
  page: Page,
  dialogId: string | null,
  tableId: string,
  timeoutMs = 8000,
): Promise<void> {
  const pager = await gridPager(page, dialogId, tableId);
  // 클릭 전에 선택된 페이지를 남겨 페이지 이동 자체가 실패했는지 구분합니다.
  console.info(
    `[g2b-pagination] advance table=${tableId} selectedBefore=${pager?.selectedPage ?? "unknown"} nextIndex=${pager?.nextIndex ?? -1}`,
  );
  if (!pager?.enabled)
    throw new ModalPaginationError("표의 다음 페이지 버튼을 찾지 못했습니다.");
  const table = page.locator(`[id=${JSON.stringify(tableId)}]`);
  const before = await table.locator("tbody").allTextContents();
  const controls = page
    .locator(scopeSelector(dialogId))
    .locator("a,button,[role='button'],input[type='button']");
  if (pager.pageListId && pager.selectedPage) {
    // 번호 묶음 이동 버튼은 행 페이지를 바꾸지 않을 수 있으므로 다음 번호를 직접 선택합니다.
    const nextNumber = page.locator(
      `[id=${JSON.stringify(pager.pageListId)}] a[index="${pager.selectedPage + 1}"]`,
    );
    if (!(await nextNumber.count())) {
      await controls
        .nth(pager.nextIndex)
        .dispatchEvent("click", undefined, { timeout: 2500 });
      await nextNumber.waitFor({ state: "visible", timeout: 2500 });
    }
    if (
      !(await nextNumber.evaluate((element) =>
        element.classList.contains("w2pageList_label_selected"),
      ))
    )
      await nextNumber.dispatchEvent("click", undefined, { timeout: 2500 });
  } else {
    await controls
      .nth(pager.nextIndex)
      .dispatchEvent("click", undefined, { timeout: 2500 });
  }
  const started = Date.now();
  let lastProgressLog = started;
  while (Date.now() - started < timeoutMs) {
    const current = await table.locator("tbody").allTextContents();
    // DOM 변경을 기다리는 동안에도 2초마다 진행 상태를 출력해 멈춘 것처럼 보이지 않게 합니다.
    if (Date.now() - lastProgressLog >= 2000) {
      const state = await gridPager(page, dialogId, tableId);
      console.info(
        `[g2b-pagination] 대기 중 stage=페이지 이동 후 DOM 변경 table=${tableId} ` +
          `selectedBefore=${pager.selectedPage ?? "unknown"} selectedNow=${state?.selectedPage ?? "unknown"} ` +
          `elapsedMs=${Date.now() - started} timeoutMs=${timeoutMs}`,
      );
      lastProgressLog = Date.now();
    }
    // 기존 완료 조건은 변경하지 않습니다. 여기서는 행 텍스트 변경이 감지된 사실만 기록합니다.
    if (JSON.stringify(current) !== JSON.stringify(before)) {
      const after = await gridPager(page, dialogId, tableId);
      console.info(
        `[g2b-pagination] advance table=${tableId} selectedAfter=${after?.selectedPage ?? "unknown"} changed=true elapsedMs=${Date.now() - started}`,
      );
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new ModalPaginationError(
    `표 페이지 전환 후 행이 갱신되지 않았습니다: ${tableId}`,
  );
}

const tablesIn = (sections: StructuredSection[]): StructuredTable[] =>
  sections.flatMap((section) => [
    ...section.tables,
    ...section.fields.flatMap((field) => field.tables || []),
  ]);

/** 호출 원인을 추적하기 위한 실행별 ID입니다. 서버 프로세스 내에서 증가합니다. */
let paginationInvocationSequence = 0;

/**
 * 재수집 호출과 페이지 상태 변화를 터미널 및 JSONL 파일에 함께 기록합니다.
 * 파일 기록 실패는 실제 수집 흐름을 중단하지 않습니다.
 */
async function tracePagination(event: Record<string, unknown>): Promise<void> {
  const record = { timestamp: new Date().toISOString(), ...event };
  console.info(`[g2b-pagination-trace] ${JSON.stringify(record)}`);
  try {
    const directory = join(process.cwd(), ".g2b-pagination-debug");
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, "invocations.jsonl"), JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    console.error("[g2b-pagination-trace] 로그 파일 저장 실패", error);
  }
}

/** 현재 선택된 페이지 번호를 관측합니다. DOM 상태만 읽고 변경하지 않습니다. */
async function selectedPaginationPage(page: Page, dialogId: string | null, tableId: string | null): Promise<number | null> {
  if (!tableId) return null;
  return (await gridPager(page, dialogId, tableId))?.selectedPage ?? null;
}

/** 페이지가 있는 모든 표의 행을 합치고 각 페이지의 클릭 상세를 탐색합니다. */
export async function collectPaginatedModal(
  page: Page,
  dialogId: string | null,
  _baseUrl: string,
  options: {
    timeoutMs?: number;
    onPage?: (
      pageNumber: number,
      tableId: string | null,
      rowOffset: number,
    ) => Promise<void>;
  } = {},
): Promise<{ sections: StructuredSection[]; pageCount: number }> {
  // 재진입 여부를 확인할 수 있도록 호출 시점의 스택과 모달 ID를 남깁니다.
  const invocationId = ++paginationInvocationSequence;
  const callerStack = new Error("pagination invocation").stack?.split("\n").slice(1, 9).join(" | ") || "unknown";
  await tracePagination({ event: "start", invocationId, dialogId, url: page.url(), callerStack });
  await ensureTableIds(page, dialogId);
  const kind = dialogId ? "modal" : "page";
  const sections = extractCommonSections(await modalHtml(page, dialogId), kind);
  // 첫 페이지 콜백이 모달을 열거나 페이지를 초기화하는지도 기록합니다.
  await tracePagination({ event: "onPage-before", invocationId, dialogId, pageNumber: 1, tableId: null });
  await options.onPage?.(1, null, 0);
  await tracePagination({ event: "onPage-after", invocationId, dialogId, pageNumber: 1, tableId: null });
  let pageCount = 1;
  for (const table of tablesIn(sections)) {
    if (
      !table.sourceId ||
      /_scrollX_table$/.test(table.sourceId) ||
      !table.bodyRows.length
    )
      continue;
    const pager = await gridPager(page, dialogId, table.sourceId);
    if (!pager || pager.total <= table.bodyRows.length) continue;
    const firstCount = table.bodyRows.length;
    let currentPage = 1;
    // 첫 페이지의 행 수를 페이지 크기로 사용한다는 기존 가정을 유지합니다.
    const totalPages = Math.ceil(pager.total / firstCount);
    await tracePagination({ event: "table-start", invocationId, dialogId, tableId: table.sourceId, totalRows: pager.total, totalPages, selectedPage: pager.selectedPage });
    while (table.bodyRows.length < pager.total) {
      // 매 페이지마다 별도 상태를 만들면 오류가 나도 마지막 성공 페이지와 실패 단계를 식별할 수 있습니다.
      const diagnostic: PaginationDiagnostic = {
        tableId: table.sourceId,
        pageNumber: currentPage + 1,
        totalPages,
        collectedRows: table.bodyRows.length,
        totalRows: pager.total,
        stage: "페이지 이동 준비",
        startedAt: Date.now(),
      };
      try {
        if (currentPage >= totalPages + 2)
          throw new ModalPaginationError(
            "표 페이지 수가 전체 건수와 일치하지 않습니다.",
          );
        logPagination(diagnostic, "시작");
        // 페이지 번호 클릭과 표 DOM 변경을 기다리는 기존 함수를 호출합니다.
        diagnostic.stage = "페이지 이동 및 DOM 변경 대기";
        const selectedBefore = await selectedPaginationPage(page, dialogId, table.sourceId);
        await tracePagination({ event: "advance-before", invocationId, dialogId, tableId: table.sourceId, expectedPage: currentPage + 1, selectedBefore });
        await advanceModalPage(
          page,
          dialogId,
          table.sourceId,
          options.timeoutMs,
        );
        currentPage++;
        await tracePagination({ event: "advance-after", invocationId, dialogId, tableId: table.sourceId, expectedPage: currentPage, selectedAfter: await selectedPaginationPage(page, dialogId, table.sourceId) });
        pageCount = Math.max(pageCount, currentPage);
        // DOM 변경 이후에도 파싱 결과의 행 수와 내용이 안정될 때까지 기다리는 별도 단계입니다.
        diagnostic.stage = "표 데이터 추출 및 행 안정화";
        // WebSquare는 페이지 표시를 먼저 바꾸고 행을 나중에 채우므로 완성된 행이 안정될 때까지 기다립니다.
        const expectedRows = Math.min(
          firstCount,
          pager.total - table.bodyRows.length,
        );
        diagnostic.expectedRows = expectedRows;
        const started = Date.now();
        let stableSignature = "";
        let stableSince = started;
        let currentRows: StructuredTable["bodyRows"] | undefined;
        let lastProgressLog = started;
        while (Date.now() - started < (options.timeoutMs || 8000)) {
          const candidate = tablesIn(
            extractCommonSections(await modalHtml(page, dialogId), kind),
          ).find((item) => item.sourceId === table.sourceId);
          // 마지막 페이지에는 이전 페이지의 숨겨진 행이 남을 수 있어 표시 행만 완료 판정에 사용합니다.
          const visibleRows = candidate
            ? candidate.bodyRows.filter(
                (_, index) => candidate.bodyRowVisibility?.[index] !== false,
              )
            : [];
          // 추출된 전체 행과 실제 표시 행을 각각 기록해 숨김 행/파싱 문제를 구별합니다.
          diagnostic.extractedRows = candidate?.bodyRows.length ?? 0;
          diagnostic.visibleRows = visibleRows.length;
          // 수집 대기 중에도 현재 페이지, 누적 건수, 기대/표시 행 수를 2초마다 기록합니다.
          // 이 로그로 긴 재수집을 끝까지 기다리지 않고 현재 진행 지점을 확인할 수 있습니다.
          if (Date.now() - lastProgressLog >= 2000) {
            logPagination(
              diagnostic,
              `대기 중 expectedRows=${expectedRows} extractedRows=${diagnostic.extractedRows} ` +
                `visibleRows=${diagnostic.visibleRows} timeoutMs=${options.timeoutMs || 8000}`,
            );
            lastProgressLog = Date.now();
          }
          const signatures = visibleRows.map((row) =>
            JSON.stringify(row.map((cell) => cell.value)),
          );
          if (signatures.length === expectedRows) {
            const signature = JSON.stringify(signatures);
            if (
              signature === stableSignature &&
              Date.now() - stableSince >= 300
            ) {
              currentRows = visibleRows;
              break;
            }
            if (signature !== stableSignature) {
              stableSignature = signature;
              stableSince = Date.now();
            }
          } else stableSignature = "";
          await page.waitForTimeout(100);
        }
        if (!currentRows)
          throw new ModalPaginationError(
            `표의 다음 페이지 행이 완성되지 않았습니다: ${table.sourceId}`,
          );
        const rowOffset = table.bodyRows.length;
        for (const row of currentRows) {
          table.bodyRows.push(row);
        }
        table.bodyRowVisibility?.push(...currentRows.map(() => true));
        diagnostic.collectedRows = table.bodyRows.length;
        // 페이지별 상세 탐색 콜백까지 완료되어야 해당 페이지를 성공으로 기록합니다.
        diagnostic.stage = "페이지별 후처리";
        const selectedBeforeCallback = await selectedPaginationPage(page, dialogId, table.sourceId);
        await tracePagination({ event: "onPage-before", invocationId, dialogId, tableId: table.sourceId, pageNumber: currentPage, selectedPage: selectedBeforeCallback, collectedRows: table.bodyRows.length });
        await options.onPage?.(currentPage, table.sourceId, rowOffset);
        const selectedAfterCallback = await selectedPaginationPage(page, dialogId, table.sourceId);
        await tracePagination({ event: "onPage-after", invocationId, dialogId, tableId: table.sourceId, pageNumber: currentPage, selectedPage: selectedAfterCallback, changed: selectedBeforeCallback !== selectedAfterCallback });
        diagnostic.stage = "완료";
        logPagination(
          diagnostic,
          `visibleRows=${currentRows.length} expectedRows=${expectedRows}`,
        );
      } catch (error) {
        // 어느 단계에서 실패했든 동일한 형식으로 당시 DOM과 수집 상태를 남깁니다.
        const details = await capturePaginationFailure(
          page,
          dialogId,
          diagnostic,
          error,
        );
        throw new ModalPaginationError(
          `${error instanceof Error ? error.message : String(error)} [${details}]`,
        );
      }
    }
    await tracePagination({ event: "table-complete", invocationId, dialogId, tableId: table.sourceId, collectedRows: table.bodyRows.length, totalRows: pager.total });
    if (table.bodyRows.length !== pager.total)
      throw new ModalPaginationError("표의 전체 건수와 수집 행 수가 다릅니다.");
  }
  await tracePagination({ event: "invocation-complete", invocationId, dialogId, pageCount });
  return { sections, pageCount };
}
