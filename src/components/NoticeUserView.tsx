"use client";

import { useState } from "react";

import type { ScrapedDetail, StructuredField, StructuredSection, StructuredTable } from "@/lib/g2b/detail-page";
import { attachmentLinkMap } from "@/lib/g2b/attachment-map";
import { paginateTableRows, tableForUserDisplay } from "@/lib/g2b/structured-table";
import { TablePageControls } from "./TablePageControls";
import { fieldText } from "@/lib/g2b/field-value";
import { contentSections } from "@/lib/g2b/content-sections";
import { openingTargetForCell, splitNavigationValue, type NavigationTarget } from "@/lib/g2b/notice-navigation";
import { useNoticeNavigation } from "./NoticeNavigationContext";
import { FormAccordion } from "./FormAccordion";

/** 화면 문자열과 수집된 첨부파일명을 같은 기준으로 비교합니다. */
function fileNameKey(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 첨부파일 연결을 우선하고, 확인된 다른 단계의 식별자만 클릭 요소로 표시합니다. */
function DownloadValue({ value, links, section, row, column }: { value: string; links: Map<string, string>;
  section?: string; row?: number; column?: number }) {
  const href = links.get(fileNameKey(value));
  const navigation = useNoticeNavigation();
  if (href) return <a className="user-download-link" href={href} download>{value}</a>;
  if (!navigation) return value;
  const renderTarget = (text: string, target: NavigationTarget, key: number) => {
    if ("href" in target) return <a className="user-navigation-link" href={target.href} key={key}>{text}</a>;
    if (target.stage === navigation.active) return text;
    return <button className="user-navigation-button" type="button" key={key}
      onClick={() => navigation.navigate(target.stage, target.reference)}>{text}</button>;
  };
  // 번호가 아닌 상태값은 저장된 개찰 트리거와 셀 위치가 모두 확인될 때만 연결합니다.
  if (section && row !== undefined && column !== undefined) {
    const opening = openingTargetForCell(section, row, column, value, navigation.targets.opening);
    if (opening) return renderTarget(value, opening, 0);
  }
  return splitNavigationValue(value, navigation.targets).map((part, index) =>
    part.target ? renderTarget(part.text, part.target, index) : part.text);
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

type LinkedDetail = NonNullable<StructuredSection["details"]>[number];

/** 하위 상세까지 살펴 사용자에게 표시할 내용이 있는 섹션인지 판별합니다. */
function hasVisibleSectionContent(section: StructuredSection): boolean {
  return section.visible !== false && (visibleFields(section.fields).length > 0 ||
    section.tables.some(hasVisibleTableData) || section.details?.some(hasVisibleDetailContent) === true);
}

/** 모달의 실제 표시 가능한 섹션을 최상위 섹션과 같은 기준으로 찾습니다. */
function hasVisibleDetailContent(detail: LinkedDetail): boolean {
  return contentSections(detail, detail.title).some(hasVisibleSectionContent);
}

/** 저장된 표의 행·열 병합 구조를 사용자 화면에 표시합니다. */
function UserTable({ table, label, links, section }: { table: StructuredTable; label: string;
  links: Map<string, string>; section?: string }) {
  const [pageIndex, setPageIndex] = useState(0);
  if (!hasVisibleTableData(table)) return null;
  const structured = tableForUserDisplay(table);
  const bodyRows = structured.bodyRows.map((cells, index) => ({ cells, index }))
    .filter(({ index }) => structured.bodyRowVisibility?.[index] !== false);
  const headerRows = structured.headerRows.map((cells, index) => ({ cells, index }))
    .filter(({ index }) => structured.headerRowVisibility?.[index] !== false);
  const pageLengths = paginateTableRows(bodyRows.map(({ cells }) => cells)).map((rows) => rows.length);
  const current = Math.min(pageIndex, pageLengths.length - 1);
  const start = pageLengths.slice(0, current).reduce((sum, size) => sum + size, 0);
  const shownRows = bodyRows.slice(start, start + pageLengths[current]);
  return <div className="user-table-wrap"><table className="user-table" aria-label={label}>
    {headerRows.length > 0 && <thead>{headerRows.map(({ cells, index }) => <tr key={index}>
      {cells.map((cell, cellIndex) => <th key={cellIndex}
        scope={cell.colspan > 1 ? "colgroup" : "col"}
        rowSpan={visibleRowSpan(structured.headerRowVisibility, index, cell.rowspan)} colSpan={cell.colspan}>
        <DownloadValue value={visibleCellValue(cell)} links={links} /></th>)}
    </tr>)}</thead>}
    <tbody>{shownRows.map(({ cells, index }) => <tr key={index}>
      {cells.map((cell, cellIndex) => <td key={cellIndex}
        rowSpan={visibleRowSpan(structured.bodyRowVisibility, index, cell.rowspan)} colSpan={cell.colspan}>
        <DownloadValue value={visibleCellValue(cell)} links={links} section={section}
          row={index} column={cell.column} /></td>)}
    </tr>)}</tbody>
  </table><TablePageControls pagination={table.pagination} page={current} count={pageLengths.length}
    onPage={setPageIndex} /></div>;
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

/** 연결된 모달의 섹션과 그 안의 하위 상세를 같은 표시 기준으로 렌더링합니다. */
function UserLinkedDetail({ item, sectionTitle }: { item: LinkedDetail; sectionTitle: string }) {
  const links = attachmentLinkMap(item.attachments || []);
  return <div className="user-linked-detail">
    <h3>{item.title}</h3>
    {contentSections(item, item.title).filter(hasVisibleSectionContent).map((part, partIndex) =>
      <div key={partIndex}>
        {item.sections && <h4>{part.title}</h4>}
        <UserFields fields={part.fields} links={links} />
        {part.tables.map((table, tableIndex) => <UserTable table={table}
          label={`${sectionTitle} ${item.title} ${part.title} 표 ${tableIndex + 1}`}
          links={links} section={part.title} key={tableIndex} />)}
        {part.details?.filter(hasVisibleDetailContent).map((child, childIndex) =>
          <UserLinkedDetail item={child} sectionTitle={part.title} key={childIndex} />)}
      </div>)}
  </div>;
}

/** 섹션의 필드·표·연결된 상세를 표시 상태에 맞춰 제공합니다. */
export function NoticeUserView({ detail }: { detail: ScrapedDetail | null }) {
  if (!detail) return <p className="muted user-empty">상세 페이지 수집 자료가 없습니다.</p>;
  const links = attachmentLinkMap(detail.attachments);
  // 표시 가능한 값이 없는 섹션은 빈 카드로 남기지 않습니다.
  const sections = (detail.sections || []).filter(hasVisibleSectionContent);
  if (!sections.length) return <p className="muted user-empty">표시할 상세 정보가 없습니다.</p>;
  return <div className="user-sections">{sections.map((section, index) => <FormAccordion
    title={section.title} key={`${section.title}-${index}`} defaultOpen>
      <UserFields fields={section.fields} links={links} />
      {section.tables.map((table, tableIndex) => <UserTable table={table}
        label={`${section.title} 표 ${tableIndex + 1}`} links={links} section={section.title} key={tableIndex} />)}
      {section.details?.filter(hasVisibleDetailContent).map((item, detailIndex) =>
        <UserLinkedDetail item={item} sectionTitle={section.title} key={detailIndex} />)}
  </FormAccordion>)}</div>;
}
