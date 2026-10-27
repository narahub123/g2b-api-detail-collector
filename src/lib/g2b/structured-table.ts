import type * as cheerio from "cheerio";

export type StructuredTableContent = { value: string; visible: boolean };
export type StructuredTableCell = { value: string | null; column: number; rowspan: number; colspan: number;
  visible?: boolean; contents?: StructuredTableContent[] };
export type StructuredTable = { headerRows: StructuredTableCell[][]; bodyRows: StructuredTableCell[][];
  visible?: boolean; headerRowVisibility?: boolean[]; bodyRowVisibility?: boolean[]; columnVisibility?: boolean[];
  sourceId?: string; pagination?: { status: "complete" | "partial" | "unknown"; expectedTotal?: number;
    collectedRows: number; pageRanges: { page: number; start: number; count: number }[];
    missingPages?: number[]; errors: string[] } };
export type LegacyStructuredTable = { columns: string[]; rows: (string | null)[][] };

/** 병합 셀이 경계에 걸리지 않도록 목표 행 수와 가장 가까운 안전한 구간으로 나눕니다. */
export function paginateTableRows<T extends StructuredTableCell[]>(rows: T[], pageSize = 10): T[][] {
  const pages: T[][] = [];
  for (let start = 0; start < rows.length;) {
    const target = Math.min(start + pageSize, rows.length);
    const safe = (end: number) => rows.slice(start, end).every((row, offset) =>
      row.every((cell) => start + offset + cell.rowspan <= end));
    let end = target;
    if (!safe(end)) {
      while (end > start + 1 && !safe(end)) end--;
      if (!safe(end)) {
        end = target;
        while (end < rows.length && !safe(end)) end++;
      }
    }
    pages.push(rows.slice(start, end));
    start = end;
  }
  return pages;
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const nonempty = (value: string) => clean(value) || null;

/** Match the existing section/field rule: inline styles on the node or any ancestor. */
export function isInlineVisible($: cheerio.CheerioAPI, node: any): boolean {
  for (let current = node; current; current = current.parent) {
    if (current.type !== "tag") continue;
    for (const declaration of ($(current).attr("style") || "").split(";")) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      const name = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1).replace(/\s*!important\s*$/i, "").trim().toLowerCase();
      if ((name === "display" && value === "none") || (name === "visibility" && value === "hidden")) return false;
    }
  }
  return true;
}

/** colgroup의 0px 열을 찾아 표의 실제 표시 열 정보를 반환합니다. */
function columnVisibility($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>): boolean[] | undefined {
  const columns: boolean[] = [];
  /** 자식 col에 선언한 너비가 있으면 colgroup보다 우선합니다. */
  const widthFrom = (element: any): string | undefined => /(?:^|;)\s*width\s*:\s*([^;]+)/i.exec($(element).attr("style") || "")?.[1]
    ?.replace(/\s*!important\s*$/i, "").trim().toLowerCase() || $(element).attr("width")?.trim().toLowerCase();
  table.children("colgroup").each((_, group) => {
    const children = $(group).children("col").toArray();
    const nodes = children.length ? children : [group];
    for (const node of nodes) {
      const width = widthFrom(node) || widthFrom(group);
      const parsedSpan = Number($(node).attr("span") || 1);
      const span = Number.isSafeInteger(parsedSpan) && parsedSpan > 0 ? parsedSpan : 1;
      for (let index = 0; index < span; index++) columns.push(!/^0(?:\.0+)?(?:px)?$/.test(width || ""));
    }
  });
  return columns.length ? columns : undefined;
}

/** 숨겨진 빈 보조 셀이 헤더보다 본문을 한 열 늘리면 그 셀을 제외하고 열 위치를 맞춥니다. */
function alignOverflowCells(rows: StructuredTableCell[][], width: number): StructuredTableCell[][] {
  if (!width) return rows;
  return rows.map((row) => {
    let overflow = Math.max(0, ...row.map((cell) => cell.column + cell.colspan)) - width;
    if (overflow <= 0) return row;
    let shift = 0;
    return row.flatMap((cell) => {
      if (overflow >= cell.colspan && cell.visible === false && !cell.value?.trim()) {
        overflow -= cell.colspan;
        shift += cell.colspan;
        return [];
      }
      return [{ ...cell, column: cell.column - shift }];
    });
  });
}

/** 셀이 걸친 모든 열의 너비가 0px이면 셀 내용도 숨김 상태로 기록합니다. */
function applyColumnVisibility(rows: StructuredTableCell[][], visibility: boolean[] | undefined): StructuredTableCell[][] {
  if (!visibility) return rows;
  return rows.map((row) => row.map((cell) => {
    const shown = visibility.slice(cell.column, cell.column + cell.colspan).some(Boolean);
    return shown ? cell : { ...cell, visible: false,
      contents: cell.contents?.map((item) => ({ ...item, visible: false })) };
  }));
}

/** 행 선택 컨트롤인 셀의 원래 열 위치를 찾습니다. */
function selectionColumns($: cheerio.CheerioAPI, sourceRows: any[], rows: StructuredTableCell[][]): Set<number> {
  const excluded = new Set<number>();
  sourceRows.slice(0, rows.length).forEach((row, rowIndex) => {
    $(row).children("th,td").toArray().forEach((node, cellIndex) => {
      const cell = $(node);
      const id = cell.attr("col_id") || "";
      const hasCheckbox = cell.find("input[type='checkbox'],[role='checkbox']").length > 0;
      if (!/^(?:chk|checkbox|row.?select|select)$/i.test(id) &&
          !(hasCheckbox && /선택/.test(clean(cell.text())))) return;
      const placed = rows[rowIndex]?.[cellIndex];
      if (placed) for (let column = placed.column; column < placed.column + placed.colspan; column++) excluded.add(column);
    });
  });
  return excluded;
}

/** 행 선택 열을 헤더·본문·colgroup에서 함께 제거해 열 위치를 유지합니다. */
function withoutColumns(rows: StructuredTableCell[][], excluded: Set<number>): StructuredTableCell[][] {
  if (!excluded.size) return rows;
  return rows.map((row) => row.flatMap((cell) => {
    const kept = Array.from({ length: cell.colspan }, (_, offset) => cell.column + offset)
      .filter((column) => !excluded.has(column));
    if (!kept.length) return [];
    const before = [...excluded].filter((column) => column < cell.column).length;
    return [{ ...cell, column: cell.column - before, colspan: kept.length }];
  }));
}

function cellContents($: cheerio.CheerioAPI, cell: any): StructuredTableContent[] {
  const contents: StructuredTableContent[] = [];
  const append = (value: string | null, node: any) => {
    if (value) contents.push({ value, visible: isInlineVisible($, node) });
  };
  const visit = (node: any): void => {
    if (node.type === "text") { append(nonempty(node.data || ""), node.parent); return; }
    if (node.type !== "tag") return;
    const element = $(node);
    if (element.is("script,style,option")) return;
    if (element.is("input,textarea,select")) {
      append(nonempty(String(element.val() ?? element.attr("value") ?? "")), node);
      return;
    }
    for (const child of node.children || []) visit(child);
  };
  for (const child of cell.children || []) visit(child);
  return contents;
}

/** WebSquare pads grids with empty rows; retain gaps and rows covered by actual values. */
function withoutTrailingEmptyRows(rows: StructuredTableCell[][], isPaddingRow: (index: number) => boolean = () => false): StructuredTableCell[][] {
  let lastDataRow = -1;
  rows.forEach((row, index) => row.forEach((cell) => {
    if (cell.value !== null && cell.value.trim()) lastDataRow = Math.max(lastDataRow, index + cell.rowspan - 1);
    if (cell.visible === false && !isPaddingRow(index)) lastDataRow = Math.max(lastDataRow, index + cell.rowspan - 1);
  }));
  return rows.slice(0, lastDataRow + 1);
}

function positionedRows($: cheerio.CheerioAPI, sourceRows: any[], readCell: (cell: any) => string | null): StructuredTableCell[][] {
  const occupied = new Set<string>();
  return sourceRows.map((row, rowIndex) => {
    let column = 0;
    return $(row).children("th,td").toArray().map((cell): StructuredTableCell => {
      const readSpan = (name: "rowspan" | "colspan") => {
        const value = Number($(cell).attr(name));
        if (name === "rowspan" && value === 0) {
          const group = $(row).parent()[0];
          const nextGroup = sourceRows.slice(rowIndex).findIndex((later) => $(later).parent()[0] !== group);
          return nextGroup < 0 ? sourceRows.length - rowIndex : nextGroup;
        }
        return Number.isSafeInteger(value) && value > 0 ? value : 1;
      };
      const rowspan = readSpan("rowspan");
      const colspan = readSpan("colspan");
      while (Array.from({ length: colspan }, (_, offset) => occupied.has(`${rowIndex}:${column + offset}`)).some(Boolean)) column++;
      const placed = { value: readCell($(cell)), column, rowspan, colspan,
        visible: isInlineVisible($, cell), contents: cellContents($, cell) };
      for (let rowOffset = 0; rowOffset < rowspan; rowOffset++) {
        for (let columnOffset = 0; columnOffset < colspan; columnOffset++) {
          occupied.add(`${rowIndex + rowOffset}:${column + columnOffset}`);
        }
      }
      column += colspan;
      return placed;
    });
  });
}

/** 상세페이지와 모달 표의 직접 소속 행만 읽어 셀·병합·열 표시 상태를 같은 규칙으로 보존합니다. */
export function extractDetailTable($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>, readCell: (cell: any) => string | null): StructuredTable | null {
  const rows = table.find("tr").filter((_, row) => $(row).closest("table")[0] === table[0]).toArray();
  if (!rows.length) return null;
  const first = $(rows[0]).children("th,td");
  const hasColId = rows.some((row) => $(row).children("th[col_id],td[col_id]").length > 0);
  const hasThead = rows.some((row) => $(row).closest("thead")[0]?.parent === table[0]);
  // data-title로 이미 필드가 되는 서식 표는 동일 값을 표로 다시 저장하지 않습니다.
  const isFieldTable = !/grd|grid/i.test(table.attr("id") || "") && !hasColId && !hasThead &&
    rows.some((row) => $(row).children("td[data-title]:not([col_id])").length > 0 ||
      $(row).children("th").toArray().some((th) => $(th).next().is("td:not([col_id])")));
  if (isFieldTable) return null;
  const isGrid = /grd|grid/i.test(table.attr("id") || "") || hasColId || hasThead ||
    rows.some((row) => $(row).children("td[data-title]").length > 0) ||
    (rows.length > 1 && first.length > 0 && first.filter("th").length === first.length);
  if (!isGrid) return null;

  const explicitHeader = rows.filter((row) => $(row).closest("thead")[0]?.parent === table[0]);
  let headerLength = explicitHeader.length;
  if (!headerLength) {
    headerLength = rows.findIndex((row) => {
      const cells = $(row).children("th,td");
      return !cells.length || cells.filter("th").length !== cells.length;
    });
    if (headerLength < 0) headerLength = rows.length;
  }
  const headerNodes = rows.slice(0, headerLength);
  const bodyNodes = rows.slice(headerLength);
  const columns = columnVisibility($, table);
  let headerRows = positionedRows($, headerNodes, (cell) => nonempty(cell.text()));
  // 헤더가 없는 col_id 그리드는 첫 데이터 행의 열 이름으로 공통 헤더를 만듭니다.
  const generatedHeader = !headerRows.length && hasColId;
  if (generatedHeader) {
    const firstData = bodyNodes.find((row) => $(row).children("td[col_id]").length > 0);
    headerRows = [$(firstData).children("td[col_id]").toArray().map((cell, column) => {
      const id = $(cell).attr("col_id") || "";
      return { value: id, column, rowspan: 1, colspan: 1,
        visible: isInlineVisible($, table[0]), contents: [] };
    })];
  }
  const headerWidth = Math.max(0, ...headerRows.flat().map((cell) => cell.column + cell.colspan));
  const rawBodyRows = positionedRows($, bodyNodes, readCell);
  const excluded = selectionColumns($, headerNodes, headerRows);
  for (const column of selectionColumns($, bodyNodes, rawBodyRows)) excluded.add(column);
  const bodyRows = withoutTrailingEmptyRows(rawBodyRows,
    (index) => $(bodyNodes[index]).hasClass("w2grid_hidedRow"));
  // WebSquare의 숨겨진 빈 보조 셀이 colgroup 수보다 셀 한 칸을 더 만드는 경우를 정렬합니다.
  const alignedBody = alignOverflowCells(bodyRows, columns?.length || headerWidth);
  const retainedColumns = columns?.filter((_, index) => !excluded.has(index));
  const projectedBody = withoutTrailingEmptyRows(withoutColumns(applyColumnVisibility(alignedBody, columns), excluded),
    (index) => $(bodyNodes[index]).hasClass("w2grid_hidedRow"));
  const projectedHeader = withoutColumns(applyColumnVisibility(headerRows, columns), excluded);
  const hasHeader = projectedHeader.some((row) => row.some((cell) => Boolean(cell.value?.trim())));
  const explicitGrid = /grd|grid/i.test(table.attr("id") || "") || hasColId || hasThead;
  return projectedBody.length || (explicitGrid && hasHeader) ? { headerRows: projectedHeader,
    ...(table.attr("id") ? { sourceId: table.attr("id") } : {}),
    bodyRows: projectedBody,
    ...(retainedColumns ? { columnVisibility: retainedColumns } : {}),
    visible: isInlineVisible($, table[0]),
    headerRowVisibility: generatedHeader ? [isInlineVisible($, table[0])] :
      headerNodes.map((row) => isInlineVisible($, row)),
    bodyRowVisibility: bodyNodes.slice(0, projectedBody.length).map((row) => isInlineVisible($, row)) } : null;
}

export function tableHasValue(table: StructuredTable): boolean {
  return table.bodyRows.some((row) => row.some((cell) => Boolean(cell.value)));
}

/** Old JSON had already lost spans; this only keeps it readable without changing saved files. */
export function tableForDisplay(table: StructuredTable | LegacyStructuredTable): StructuredTable {
  if ("headerRows" in table && "bodyRows" in table) {
    const bodyRows = withoutTrailingEmptyRows(table.bodyRows, () => true);
    return { ...table, bodyRows, bodyRowVisibility: table.bodyRowVisibility?.slice(0, bodyRows.length) };
  }
  const width = Math.max(table.columns.length, ...table.rows.map((row) => row.length));
  return {
    headerRows: [Array.from({ length: width }, (_, column) => ({
      value: table.columns[column] || `열 ${column + 1}`, column, rowspan: 1, colspan: 1
    }))],
    bodyRows: table.rows.map((row) => Array.from({ length: width }, (_, column) => ({
      value: row[column] ?? null, column, rowspan: 1, colspan: 1
    })))
  };
}

/** 사용자 화면에서 숨겨진 보조 셀과 0px 열을 제외해 헤더·본문 위치를 맞춥니다. */
export function tableForUserDisplay(table: StructuredTable | LegacyStructuredTable): StructuredTable {
  const structured = tableForDisplay(table);
  const visibility = structured.columnVisibility;
  const headerWidth = Math.max(0, ...structured.headerRows.flat().map((cell) => cell.column + cell.colspan));
  const bodyRows = alignOverflowCells(structured.bodyRows, visibility?.length || headerWidth);
  if (!visibility) return { ...structured, bodyRows };
  const before = (column: number) => visibility.slice(0, column).filter(Boolean).length;
  const project = (rows: StructuredTableCell[][]) => rows.map((row) => row.flatMap((cell) => {
    const colspan = visibility.slice(cell.column, cell.column + cell.colspan).filter(Boolean).length;
    return colspan ? [{ ...cell, column: before(cell.column), colspan }] : [];
  }));
  return { ...structured, headerRows: project(structured.headerRows), bodyRows: project(bodyRows) };
}
