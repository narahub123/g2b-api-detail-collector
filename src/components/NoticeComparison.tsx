import type { ApiNotice } from "@/lib/g2b/types";
import type { ModalCapture, ScrapedDetail, StructuredField, StructuredTable } from "@/lib/g2b/detail-page";
import { apiFieldDisplayName } from "@/lib/g2b/api-field-labels";
import type { IndependentReference } from "@/lib/g2b/notices";
import { tableForDisplay } from "@/lib/g2b/structured-table";
import { safeAttachmentLink } from "@/lib/g2b/attachment-links";
import { contentSections } from "@/lib/g2b/content-sections";
import { attachmentLinkMap } from "@/lib/g2b/attachment-map";
import { fieldText } from "@/lib/g2b/field-value";

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** 확인된 첨부 URL이 있는 파일명만 다운로드 링크로 표시합니다. */
function LinkedValue({ value, links }: { value: string; links?: ReadonlyMap<string, string> }) {
  const href = links?.get(value.replace(/\s+/g, " ").trim());
  return href ? <a href={href} download>{value}</a> : value;
}

/** 필드의 값과 그 필드가 소유한 표를 같은 값 영역에 표시합니다. */
function FieldList({ fields, apiLabels = false, group = "필드", links }: { fields: StructuredField[];
  apiLabels?: boolean; group?: string; links?: ReadonlyMap<string, string> }) {
  if (!fields.length) return <p className="muted comparison-empty">수집된 필드가 없습니다.</p>;
  return <dl className="raw-fields">{fields.map((field, index) => {
    const value = apiLabels ? field.value[0]?.text || "" : fieldText(field.value) || "";
    const href = safeLink(value);
    return <div className={`raw-field${value.includes("\n") ? " raw-field--multiline" : ""}`} key={`${field.label}-${index}`}>
      <dt>{apiLabels ? apiFieldDisplayName(field.label) : field.label}</dt>
      <dd>{value ? links?.has(value.replace(/\s+/g, " ").trim()) ? <LinkedValue value={value} links={links} /> :
        href ? <a href={href} target="_blank" rel="noopener noreferrer">{value}</a> : value
        : !field.tables?.length && <span className="muted">값 없음</span>}
        {field.tables?.map((table, tableIndex) => <DataTable table={table}
          name={`${group} ${field.label} 표 ${tableIndex + 1}`} links={links} key={tableIndex} />)}</dd>
    </div>;
  })}</dl>;
}

/** 추출된 표 셀의 파일명을 해당 자료에서 확인한 다운로드 URL과 연결합니다. */
function DataTable({ table, name, links }: { table: StructuredTable; name: string; links?: ReadonlyMap<string, string> }) {
  const structured = tableForDisplay(table);
  if (!structured.bodyRows.some((row) => row.some((cell) => Boolean(cell.value?.trim()))))
    return <p className="muted comparison-empty">표에 값이 없습니다.</p>;
  return <div className="comparison-table-wrap"><table className="comparison-table" aria-label={name}>
    <thead>{structured.headerRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) =>
      <th key={cellIndex} scope={cell.colspan > 1 ? "colgroup" : "col"} rowSpan={cell.rowspan} colSpan={cell.colspan}>
        <LinkedValue value={cell.value || ""} links={links} /></th>
    )}</tr>)}</thead>
    <tbody>{structured.bodyRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) =>
      <td key={cellIndex} rowSpan={cell.rowspan} colSpan={cell.colspan}>
        <LinkedValue value={cell.value ?? ""} links={links} /></td>
    )}</tr>)}</tbody>
  </table></div>;
}

/** 한 자료에 속한 표와 다운로드 링크를 함께 표시합니다. */
function TableList({ tables, group, links }: { tables: StructuredTable[]; group: string;
  links?: ReadonlyMap<string, string> }) {
  if (!tables.length) return null;
  return <div className="comparison-tables">{tables.map((table, index) => <div className="comparison-table-block" key={index}>
    <h5>표 {index + 1}</h5><DataTable table={table} name={`${group} 표 ${index + 1}`} links={links} />
  </div>)}</div>;
}

/** 저장된 모달이 어떤 클릭으로 열렸는지 비교 화면에 표시합니다. */
function ClickSources({ triggers }: { triggers: ModalCapture["trigger"][] }) {
  return triggers.map((trigger, index) => <p className="muted" key={index}>
    클릭 출처: {trigger.label} · {trigger.value}
    {trigger.parentModalTitle ? ` (${trigger.parentModalTitle}에서 열림)` : ""}
  </p>);
}

/**
 * API 응답, 섹션 상세, 독립 저장 자료를 공고별로 비교해 보여줍니다.
 * @param props 읽은 공고 자료와 번호로 연결한 독립 상세 참조
 * @returns 원문 필드 및 참조 상세를 표시하는 비교 화면
 */
export function NoticeComparison({ api, detail, orderPlans = [], preSpecifications = [], otherDetails = [], openingDetails = [] }: { api: ApiNotice | null; detail: ScrapedDetail | null;
  orderPlans?: IndependentReference[]; preSpecifications?: IndependentReference[]; otherDetails?: IndependentReference[];
  openingDetails?: IndependentReference[] }) {
  const apiFields = Object.entries(api || {}).map(([label, value]) => ({ label,
    value: [{ text: displayValue(value), visible: true }] }));
  const detailFieldCount = detail?.sections?.reduce((count, section) => count + section.fields.length, 0) || 0;
  const pageLinks = attachmentLinkMap(detail?.attachments || []);
  const captures = [...(detail?.modalCaptures || []), ...(detail?.baseAmountCaptures || []), ...(detail?.changeNoticeCaptures || [])];
  const independent = [...orderPlans.map((item) => ({ ...item, kind: "발주계획" })),
    ...preSpecifications.map((item) => ({ ...item, kind: "사전규격" })),
    ...otherDetails.map((item) => ({ ...item, kind: item.number.slice(3, 5) === "TA" ? "계약" : "입찰공고" })),
    ...openingDetails.map((item) => ({ ...item, kind: "개찰" }))];

  return <>
    <nav className="comparison-jumps" aria-label="비교 항목 바로가기">
      <a href="#comparison-api">API 응답</a>
      <a href="#comparison-detail">상세 페이지 정보</a>
      {detail && <a href="#comparison-clicked">클릭 상세 정보</a>}
    </nav>
    <div className="comparison-columns">
    <section className="comparison-panel" id="comparison-api" aria-label="API 응답 정보">
      <div className="comparison-panel-header"><h2>API 응답 정보</h2><span>{apiFields.length}개 항목</span></div>
      {api ? <><FieldList fields={apiFields} apiLabels />
        <details className="raw-json"><summary>API JSON 원문 보기</summary><pre>{JSON.stringify(api, null, 2)}</pre></details></>
        : <p className="muted comparison-empty">API 응답이 아직 없습니다.</p>}
    </section>

    <section className="comparison-panel" id="comparison-detail" aria-label="상세 정보 추출">
      <div className="comparison-panel-header"><h2>상세 정보 추출</h2><span>{detailFieldCount}개 필드</span></div>
      {detail ? <>
        <div className="comparison-group"><h3>상세 페이지 섹션 · {detail.sections?.length || 0}개</h3>
          {detail.sections?.length ? detail.sections.map((section, index) => <details className="comparison-card" key={`${section.title}-${index}`} open>
            <summary>{section.title} <span>필드 {section.fields.length} · 표 {section.tables.length}</span></summary>
            {(section.fields.length > 0 || !section.details?.length) && <FieldList fields={section.fields} group={section.title} links={pageLinks} />}
            <TableList tables={section.tables} group={section.title} links={pageLinks} />
            {section.details?.map((item, detailIndex) => <div className="comparison-detail-block" key={detailIndex}>
              <h4>{item.title}</h4>
              {item.trigger && <ClickSources triggers={[item.trigger]} />}
              {contentSections(item, item.title).map((part, partIndex) => <div key={partIndex}>
                {item.sections && <h5>{part.title}</h5>}
                <FieldList fields={part.fields} group={`${section.title} ${item.title} ${part.title}`}
                  links={attachmentLinkMap(item.attachments || [])} />
                <TableList tables={part.tables} group={item.sections
                  ? `${section.title} ${item.title} ${part.title} ${detailIndex + 1}`
                  : `${section.title} ${item.title} ${detailIndex + 1}`}
                  links={attachmentLinkMap(item.attachments || [])} />
              </div>)}
            </div>)}
          </details>) : <p className="muted comparison-empty">섹션별 수집 자료가 없습니다.</p>}
        </div>
        <div className="comparison-group"><h3>첨부파일 · {detail.attachments.length}개</h3>
          {detail.attachments.length ? <ul className="comparison-links">{detail.attachments.map((file, index) => {
            const href = file.url && safeAttachmentLink(file.url);
            return <li key={`${file.name}-${index}`}>{href ? <a href={href} download>{file.name}</a> : file.name}</li>;
          })}</ul> : <p className="muted comparison-empty">수집된 첨부파일이 없습니다.</p>}
        </div>
        <div className="comparison-group"><h3>수집 링크 · {detail.links.length}개</h3>
          {detail.links.length ? <ul className="comparison-links">{detail.links.map((link, index) => {
            const href = safeLink(link.url);
            return <li key={`${link.label}-${index}`}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{link.label}</a> : link.label}</li>;
          })}</ul> : <p className="muted comparison-empty">수집된 링크가 없습니다.</p>}
        </div>
        <section className="comparison-group" id="comparison-clicked" aria-label="클릭 상세 정보"><h3>클릭 상세 정보 · {captures.length}개</h3>
          {captures.length ? captures.map((capture, index) => <details className="comparison-card" key={`${capture.trigger.index}-${index}`} open>
            <summary>{capture.trigger.label} · {capture.modal.title || "제목 없음"}
              <span>필드 {contentSections(capture.modal).reduce((count, part) => count + part.fields.length, 0)} · 표 {contentSections(capture.modal).reduce((count, part) => count + part.tables.length, 0)}</span></summary>
            {capture.trigger.parentModalTitle && <p className="muted">{capture.trigger.parentModalTitle}에서 열림</p>}
            {capture.settling?.status === "timeout" && <p className="comparison-failures">값 로딩 확인 시간 초과 · 일부 값이 누락되었을 수 있습니다.</p>}
            {contentSections(capture.modal, capture.modal.title || capture.trigger.label).map((part, partIndex) =>
              <div key={partIndex}>
                {capture.modal.sections && <h4>{part.title}</h4>}
                <FieldList fields={part.fields} links={attachmentLinkMap(capture.modal.attachments || [])} />
                <TableList tables={part.tables} group={capture.modal.sections
                  ? `${capture.trigger.label} ${part.title}` : capture.trigger.label}
                  links={attachmentLinkMap(capture.modal.attachments || [])} />
              </div>)}
            {capture.modal.text && <div className="comparison-text-block"><h4>팝업 본문</h4><p>{capture.modal.text}</p></div>}
          </details>) : <p className="muted comparison-empty">수집된 클릭 상세 정보가 없습니다.</p>}
          {detail.modalDiscovery?.failures.length ? <p className="comparison-failures">수집 실패 {detail.modalDiscovery.failures.length}건: {detail.modalDiscovery.failures.join(" · ")}</p> : null}
        </section>
        {independent.length > 0 && <section className="comparison-group" aria-label="독립 상세 정보">
          <h3>참조 상세 정보 · {independent.length}개</h3>
          {independent.map((item) => <details className="comparison-card" key={`${item.kind}-${item.number}`} open>
            <summary>{item.kind} · {item.number}</summary>
            <ClickSources triggers={item.triggers?.length ? item.triggers : item.detail?.trigger ? [item.detail.trigger] : []} />
            {item.detail?.sourceNoticeKey && <p className="muted">최초 저장 공고: {item.detail.sourceNoticeKey}</p>}
            {item.detail ? contentSections(item.detail, item.detail.title || item.number).map((part, partIndex) =>
              <div key={partIndex}>
                {item.detail?.sections && <h4>{part.title}</h4>}
                <FieldList fields={part.fields} links={attachmentLinkMap(item.detail?.attachments || [])} />
                <TableList tables={part.tables} group={`${item.kind} ${item.number} ${part.title}`}
                  links={attachmentLinkMap(item.detail?.attachments || [])} />
                {part.details?.map((child, childIndex) => <div className="comparison-detail-block" key={childIndex}>
                  <h5>{child.title}</h5>
                  {child.trigger && <ClickSources triggers={[child.trigger]} />}
                  {contentSections(child, child.title).map((childPart, childPartIndex) => <div key={childPartIndex}>
                    {child.sections && <h6>{childPart.title}</h6>}
                    <FieldList fields={childPart.fields} links={attachmentLinkMap(child.attachments || [])} />
                    <TableList tables={childPart.tables} group={`${item.kind} ${child.title} ${childPart.title}`}
                      links={attachmentLinkMap(child.attachments || [])} />
                  </div>)}
                </div>)}
              </div>)
              : item.noticeKey ? <a href={`/admin/bids/${encodeURIComponent(item.noticeKey)}`}>{item.number} 공고 보기</a>
              : <p className="muted comparison-empty">참조한 상세 정보가 없습니다.</p>}
          </details>)}
        </section>}
        <details className="raw-json"><summary>상세 수집 JSON 원문 보기</summary><pre>{JSON.stringify(detail, null, 2)}</pre></details>
      </> : <p className="muted comparison-empty">상세 페이지 수집 자료가 없습니다.</p>}
    </section>
    </div>
  </>;
}
