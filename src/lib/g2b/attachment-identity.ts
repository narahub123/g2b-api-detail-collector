import type { ClickDownload } from "./detail-page";

/** 상세페이지나 모달의 href 없는 WebSquare 파일 셀에서 파일 번호와 순서를 읽습니다. */
export async function collectClickDownloads(page: import("playwright-core").Page, scope?: import("playwright-core").Locator): Promise<ClickDownload[]> {
  return (scope || page).locator("td[col_id='orgnlAtchFileNm']").evaluateAll((cells) => {
    const results: ClickDownload[] = [];
    for (const cell of cells) {
      if (!(cell instanceof HTMLElement) || !cell.id) continue;
      const action = cell.querySelector("a,button");
      const href = action?.getAttribute("href");
      if (href && !href.startsWith("#") && !/^javascript:/i.test(href)) continue;
      const table = cell.closest("table[id$='_body_table']");
      const rowMatch = /_cell_(\d+)_\d+$/.exec(cell.id);
      if (!table || !rowMatch) continue;
      const gridId = table.id.slice(0, -"_body_table".length);
      const grid = (window as any).$w?.getComponentById?.(gridId);
      const rowIndex = Number(rowMatch[1]);
      if (!grid || rowIndex >= grid.getRowCount?.()) continue;
      const row = grid.getRowJSON?.(rowIndex) as Record<string, unknown> | undefined;
      if (!row) continue;
      for (const key of Object.keys(row)) {
        const match = /^(.*?)(?:UntyAtchFileNo|untyAtchFileNo)$/.exec(key);
        if (!match) continue;
        const fileNo = row[key];
        const seq = row[`${match[1]}AtchFileSqno`] ?? row[`${match[1]}atchFileSqno`];
        const number = Number(seq);
        if (typeof fileNo !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(fileNo) ||
            !Number.isSafeInteger(number) || number <= 0) continue;
        const name = cell.textContent?.replace(/\s+/g, " ").trim() || "";
        if (name) results.push({ cellId: cell.id, name, fileNo, seq: number });
      }
    }
    return results;
  });
}

