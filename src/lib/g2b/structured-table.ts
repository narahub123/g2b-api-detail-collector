import type * as cheerio from "cheerio";

export type StructuredTableCell = { value: string | null; column: number; rowspan: number; colspan: number };
export type StructuredTable = { headerRows: StructuredTableCell[][]; bodyRows: StructuredTableCell[][] };
export type LegacyStructuredTable = { columns: string[]; rows: (string | null)[][] };

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const nonempty = (value: string) => clean(value) || null;

/** WebSquare pads grids with empty rows; retain gaps and rows covered by actual values. */
function withoutTrailingEmptyRows(rows: StructuredTableCell[][]): StructuredTableCell[][] {
  let lastDataRow = -1;
  rows.forEach((row, index) => row.forEach((cell) => {
    if (cell.value !== null && cell.value.trim()) lastDataRow = Math.max(lastDataRow, index + cell.rowspan - 1);
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
      const placed = { value: readCell($(cell)), column, rowspan, colspan };
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
  const isGrid = /grd|grid/i.test(table.attr("id") || "") || hasColId || hasThead ||
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
  const headerRows = positionedRows($, rows.slice(0, headerLength), (cell) => nonempty(cell.text()));
  const bodyRows = withoutTrailingEmptyRows(positionedRows($, rows.slice(headerLength), readCell));
  return bodyRows.length ? { headerRows, bodyRows } : null;
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
      return { value: nonempty(header.text()) || id, column, rowspan: 1, colspan: 1 };
    })];
  const mergedBody = dataRows.toArray().some((row) => $(row).children("td[col_id]").toArray().some((cell) =>
    Number($(cell).attr("rowspan") || 1) !== 1 || Number($(cell).attr("colspan") || 1) !== 1));
  const bodyRows = mergedBody ? positionedRows($, dataRows.toArray(), readCell) : dataRows.toArray().map((row) => ids.flatMap((id, column) => {
    const cell = $(row).children("td[col_id]").filter((_, td) => $(td).attr("col_id") === id).first();
    return cell.length ? [{ value: readCell(cell), column, rowspan: 1, colspan: 1 }] : [];
  }));
  return { headerRows, bodyRows: withoutTrailingEmptyRows(bodyRows) };
}

export function tableHasValue(table: StructuredTable): boolean {
  return table.bodyRows.some((row) => row.some((cell) => Boolean(cell.value)));
}

/** Old JSON had already lost spans; this only keeps it readable without changing saved files. */
export function tableForDisplay(table: StructuredTable | LegacyStructuredTable): StructuredTable {
  if ("headerRows" in table && "bodyRows" in table) {
    return { ...table, bodyRows: withoutTrailingEmptyRows(table.bodyRows) };
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
