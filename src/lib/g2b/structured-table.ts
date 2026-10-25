import type * as cheerio from "cheerio";

export type StructuredTableContent = { value: string; visible: boolean };
export type StructuredTableCell = { value: string | null; column: number; rowspan: number; colspan: number;
  visible?: boolean; contents?: StructuredTableContent[] };
export type StructuredTable = { headerRows: StructuredTableCell[][]; bodyRows: StructuredTableCell[][];
  visible?: boolean; headerRowVisibility?: boolean[]; bodyRowVisibility?: boolean[]; columnVisibility?: boolean[] };
export type LegacyStructuredTable = { columns: string[]; rows: (string | null)[][] };

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

/** The notice page has real HTML header/body rows; preserve each source cell and its span. */
export function extractDetailTable($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>, readCell: (cell: any) => string | null): StructuredTable | null {
  const rows = table.find("tr").filter((_, row) => $(row).closest("table")[0] === table[0]).toArray();
  if (!rows.length) return null;
  const first = $(rows[0]).children("th,td");
  const hasColId = rows.some((row) => $(row).children("th[col_id],td[col_id]").length > 0);
  const hasThead = rows.some((row) => $(row).closest("thead")[0]?.parent === table[0]);
  // data-title로 이미 필드가 되는 서식 표는 동일 값을 표로 다시 저장하지 않습니다.
  const isFieldTable = !/grd|grid/i.test(table.attr("id") || "") && !hasColId && !hasThead &&
    rows.some((row) => $(row).children("td[data-title]:not([col_id])").length > 0);
  if (isFieldTable) return null;
  const isGrid = /grd|grid/i.test(table.attr("id") || "") || hasColId || hasThead ||
    table.find("td[data-title]").length > 0 ||
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
  const headerRows = positionedRows($, headerNodes, (cell) => nonempty(cell.text()));
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
  return projectedBody.length ? { headerRows: withoutColumns(applyColumnVisibility(headerRows, columns), excluded),
    bodyRows: projectedBody,
    ...(retainedColumns ? { columnVisibility: retainedColumns } : {}),
    visible: isInlineVisible($, table[0]),
    headerRowVisibility: headerNodes.map((row) => isInlineVisible($, row)),
    bodyRowVisibility: bodyNodes.slice(0, projectedBody.length).map((row) => isInlineVisible($, row)) } : null;
}

/** Modal WebSquare grids identify columns by col_id, which need not match their HTML row positions. */
export function extractModalGrid($: cheerio.CheerioAPI, table: cheerio.Cheerio<any>, readCell: (cell: any) => string | null): StructuredTable | null {
  const ownRows = table.find("tr").filter((_, row) => $(row).closest("table")[0] === table[0]).toArray();
  const dataRows = table.find("tr").filter((_, row) =>
    $(row).closest("table")[0] === table[0] && $(row).children("td[col_id]").length > 0);
  if (!dataRows.length) return null;
  const ids = dataRows.first().children("td[col_id]").toArray().map((cell) => $(cell).attr("col_id") || "").filter(Boolean);
  if (!ids.length) return null;
  const headerNodes = ownRows.slice(0, ownRows.indexOf(dataRows[0])).filter((row) => $(row).children("th").length > 0);
  const headerRows: StructuredTableCell[][] = headerNodes.length
    ? positionedRows($, headerNodes, (cell) => nonempty(cell.text()))
    : [ids.map((id, column) => {
      const header = table.find("th[col_id]").filter((_, th) => $(th).attr("col_id") === id).first();
      return { value: nonempty(header.text()) || id, column, rowspan: 1, colspan: 1,
        visible: isInlineVisible($, header[0] || table[0]), contents: header.length ? cellContents($, header[0]) : [] };
    })];
  const mergedBody = dataRows.toArray().some((row) => $(row).children("td[col_id]").toArray().some((cell) =>
    Number($(cell).attr("rowspan") || 1) !== 1 || Number($(cell).attr("colspan") || 1) !== 1));
  const bodyRows = mergedBody ? positionedRows($, dataRows.toArray(), readCell) : dataRows.toArray().map((row) => ids.flatMap((id, column) => {
    const cell = $(row).children("td[col_id]").filter((_, td) => $(td).attr("col_id") === id).first();
    return cell.length ? [{ value: readCell(cell), column, rowspan: 1, colspan: 1,
      visible: isInlineVisible($, cell[0]), contents: cellContents($, cell[0]) }] : [];
  }));
  const retainedBodyRows = withoutTrailingEmptyRows(bodyRows,
    (index) => $(dataRows[index]).hasClass("w2grid_hidedRow"));
  const excluded = new Set(ids.flatMap((id, index) => /^(?:chk|checkbox|row.?select|select)$/i.test(id) ? [index] : []));
  return { headerRows: withoutColumns(headerRows, excluded),
    bodyRows: withoutColumns(retainedBodyRows, excluded), visible: isInlineVisible($, table[0]),
    headerRowVisibility: headerNodes.length ? headerNodes.map((row) => isInlineVisible($, row)) : [isInlineVisible($, table[0])],
    bodyRowVisibility: dataRows.toArray().slice(0, retainedBodyRows.length).map((row) => isInlineVisible($, row)) };
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
