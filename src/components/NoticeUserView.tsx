import type { ScrapedDetail, StructuredField, StructuredTable } from "@/lib/g2b/detail-page";
import { safeAttachmentLink } from "@/lib/g2b/attachment-links";
import { tableForUserDisplay } from "@/lib/g2b/structured-table";
import { fieldText } from "@/lib/g2b/field-value";

/** 화면 문자열과 수집된 첨부파일명을 같은 기준으로 비교합니다. */
function fileNameKey(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 이름과 안전한 URL이 일대일로 대응하는 첨부파일만 링크 후보로 만듭니다. */
function attachmentLinks(detail: ScrapedDetail): Map<string, string> {
  const candidates = new Map<string, Set<string>>();
  for (const attachment of detail.attachments) {
    const href = attachment.url && safeAttachmentLink(attachment.url);
    if (!href) continue;
    const name = fileNameKey(attachment.name);
    const urls = candidates.get(name) || new Set<string>();
    urls.add(href);
    candidates.set(name, urls);
  }
  return new Map([...candidates].flatMap(([name, urls]) => urls.size === 1 ? [[name, [...urls][0]]] : []));
}

/** 추출된 표시 문자열이 첨부파일명과 일치하면 다운로드 링크로 표시합니다. */
function DownloadValue({ value, links }: { value: string; links: Map<string, string> }) {
  const href = links.get(fileNameKey(value));
  return href ? <a className="user-download-link" href={href} download>{value}</a> : value;
}

/** 사용자에게 노출할 수 있는 필드만 반환합니다. */
function visibleFields(fields: StructuredField[]): StructuredField[] {
  return fields.filter((field) => field.visible !== false &&
    (Boolean(fieldText(field.value, true)) || field.tables?.some(hasVisibleTableData)));
}


/** 숨겨진 하위 텍스트가 표 셀의 합쳐진 값으로 다시 노출되지 않게 합니다. */
function visibleCellValue(cell: StructuredTable["bodyRows"][number][number]): string {
  if (cell.visible === false) return "";
  if (cell.contents?.length) return cell.contents.filter((item) => item.visible).map((item) => item.value).join("");
  return cell.value || "";
}

/** 숨겨진 행을 제외해도 병합 셀이 차지하는 표시 행 수를 유지합니다. */
function visibleRowSpan(visibility: boolean[] | undefined, start: number, span: number): number {
  let count = 0;
  for (let index = start; index < start + span; index++) {
    if (visibility?.[index] !== false) count++;
  }
  return Math.max(1, count);
}

/** 사용자에게 실제로 표시할 값이 있는 표인지 확인합니다. */
function hasVisibleTableData(table: StructuredTable): boolean {
  if (table.visible === false) return false;
  const structured = tableForUserDisplay(table);
  return structured.bodyRows.some((cells, index) => structured.bodyRowVisibility?.[index] !== false &&
    cells.some((cell) => Boolean(visibleCellValue(cell).trim())));
}

/** 저장된 표의 행·열 병합 구조를 사용자 화면에 표시합니다. */
function UserTable({ table, label, links }: { table: StructuredTable; label: string; links: Map<string, string> }) {
  if (!hasVisibleTableData(table)) return null;
  const structured = tableForUserDisplay(table);
  const bodyRows = structured.bodyRows.map((cells, index) => ({ cells, index }))
    .filter(({ index }) => structured.bodyRowVisibility?.[index] !== false);
  const headerRows = structured.headerRows.map((cells, index) => ({ cells, index }))
    .filter(({ index }) => structured.headerRowVisibility?.[index] !== false);
  return <div className="user-table-wrap"><table className="user-table" aria-label={label}>
    {headerRows.length > 0 && <thead>{headerRows.map(({ cells, index }) => <tr key={index}>
      {cells.map((cell, cellIndex) => <th key={cellIndex}
        scope={cell.colspan > 1 ? "colgroup" : "col"}
        rowSpan={visibleRowSpan(structured.headerRowVisibility, index, cell.rowspan)} colSpan={cell.colspan}>
        <DownloadValue value={visibleCellValue(cell)} links={links} /></th>)}
    </tr>)}</thead>}
    <tbody>{bodyRows.map(({ cells, index }) => <tr key={index}>
      {cells.map((cell, cellIndex) => <td key={cellIndex}
        rowSpan={visibleRowSpan(structured.bodyRowVisibility, index, cell.rowspan)} colSpan={cell.colspan}>
        <DownloadValue value={visibleCellValue(cell)} links={links} /></td>)}
    </tr>)}</tbody>
  </table></div>;
}

/** 추출된 필드의 표시 가능한 값을 읽기 쉬운 목록으로 보여줍니다. */
function UserFields({ fields, links }: { fields: StructuredField[]; links: Map<string, string> }) {
  const shown = visibleFields(fields);
  if (!shown.length) return null;
  return <dl className="user-fields">{shown.map((field, index) => {
    const value = fieldText(field.value, true);
    return <div className="user-field" key={`${field.label}-${index}`}>
    <dt>{field.label}</dt><dd>{value && <DownloadValue value={value} links={links} />}
      {field.tables?.map((table, tableIndex) => <UserTable table={table}
        label={`${field.label} 표 ${tableIndex + 1}`} links={links} key={tableIndex} />)}</dd>
  </div>; })}</dl>;
}

/** 섹션의 필드·표·연결된 상세를 표시 상태에 맞춰 제공합니다. */
export function NoticeUserView({ detail }: { detail: ScrapedDetail | null }) {
  if (!detail) return <p className="muted user-empty">상세 페이지 수집 자료가 없습니다.</p>;
  const links = attachmentLinks(detail);
  // 표시 가능한 값이 없는 섹션은 빈 카드로 남기지 않습니다.
  const sections = (detail.sections || []).filter((section) => section.visible !== false && (
    visibleFields(section.fields).length > 0 || section.tables.some(hasVisibleTableData) ||
    section.details?.some((item) => visibleFields(item.fields).length > 0 || item.tables.some(hasVisibleTableData))));
  if (!sections.length) return <p className="muted user-empty">표시할 상세 정보가 없습니다.</p>;
  return <div className="user-sections">{sections.map((section, index) => <details
    className="user-section" key={`${section.title}-${index}`} open>
    <summary><span>{section.title}</span><span className="user-section-toggle" aria-hidden="true">⌄</span></summary>
    <div className="user-section-content">
      <UserFields fields={section.fields} links={links} />
      {section.tables.map((table, tableIndex) => <UserTable table={table}
        label={`${section.title} 표 ${tableIndex + 1}`} links={links} key={tableIndex} />)}
      {section.details?.filter((item) => visibleFields(item.fields).length > 0 ||
        item.tables.some(hasVisibleTableData)).map((item, detailIndex) => <div className="user-linked-detail" key={detailIndex}>
        <h3>{item.title}</h3>
        <UserFields fields={item.fields} links={links} />
        {item.tables.map((table, tableIndex) => <UserTable table={table}
          label={`${section.title} ${item.title} 표 ${tableIndex + 1}`} links={links} key={tableIndex} />)}
      </div>)}
    </div>
  </details>)}</div>;
}
