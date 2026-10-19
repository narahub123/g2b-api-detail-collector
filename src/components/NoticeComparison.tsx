import type { ApiNotice } from "@/lib/g2b/types";
import type { ScrapedDetail, StructuredField, StructuredTable } from "@/lib/g2b/detail-page";
import { apiFieldDisplayName } from "@/lib/g2b/api-field-labels";
import type { IndependentReference } from "@/lib/g2b/notices";
import { tableForDisplay } from "@/lib/g2b/structured-table";
import { safeAttachmentLink } from "@/lib/g2b/attachment-links";

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

function FieldList({ fields, apiLabels = false }: { fields: StructuredField[]; apiLabels?: boolean }) {
  if (!fields.length) return <p className="muted comparison-empty">수집된 필드가 없습니다.</p>;
  return <dl className="raw-fields">{fields.map((field, index) => {
    const value = displayValue(field.value);
    const href = typeof field.value === "string" ? safeLink(field.value) : null;
    return <div className={`raw-field${value.includes("\n") ? " raw-field--multiline" : ""}`} key={`${field.label}-${index}`}>
      <dt>{apiLabels ? apiFieldDisplayName(field.label) : field.label}</dt>
      <dd>{value ? href ? <a href={href} target="_blank" rel="noopener noreferrer">{value}</a> : value : <span className="muted">값 없음</span>}</dd>
    </div>;
  })}</dl>;
}

function DataTable({ table, name }: { table: StructuredTable; name: string }) {
  const structured = tableForDisplay(table);
  if (!structured.bodyRows.some((row) => row.some((cell) => Boolean(cell.value?.trim()))))
    return <p className="muted comparison-empty">표에 값이 없습니다.</p>;
  return <div className="comparison-table-wrap"><table className="comparison-table" aria-label={name}>
    <thead>{structured.headerRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) =>
      <th key={cellIndex} scope={cell.colspan > 1 ? "colgroup" : "col"} rowSpan={cell.rowspan} colSpan={cell.colspan}>{cell.value || ""}</th>
    )}</tr>)}</thead>
    <tbody>{structured.bodyRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) =>
      <td key={cellIndex} rowSpan={cell.rowspan} colSpan={cell.colspan}>{cell.value ?? ""}</td>
    )}</tr>)}</tbody>
  </table></div>;
}

function TableList({ tables, group }: { tables: StructuredTable[]; group: string }) {
  if (!tables.length) return null;
  return <div className="comparison-tables">{tables.map((table, index) => <div className="comparison-table-block" key={index}>
    <h5>표 {index + 1}</h5><DataTable table={table} name={`${group} 표 ${index + 1}`} />
  </div>)}</div>;
}

export function NoticeComparison({ api, detail, orderPlans = [], preSpecifications = [] }: { api: ApiNotice | null; detail: ScrapedDetail | null;
  orderPlans?: IndependentReference[]; preSpecifications?: IndependentReference[] }) {
  const apiFields = Object.entries(api || {}).map(([label, value]) => ({ label, value: displayValue(value) }));
  const detailFieldCount = detail?.sections?.reduce((count, section) => count + section.fields.length, 0) || 0;
  const captures = [...(detail?.modalCaptures || []), ...(detail?.baseAmountCaptures || []), ...(detail?.changeNoticeCaptures || [])];
  const independent = [...orderPlans.map((item) => ({ ...item, kind: "발주계획" })),
    ...preSpecifications.map((item) => ({ ...item, kind: "사전규격" }))];

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
            {(section.fields.length > 0 || !section.details?.length) && <FieldList fields={section.fields} />}
            <TableList tables={section.tables} group={section.title} />
            {section.details?.map((item, detailIndex) => <div className="comparison-detail-block" key={detailIndex}>
              <h4>{item.title}</h4>
              <FieldList fields={item.fields} />
              <TableList tables={item.tables} group={`${section.title} ${item.title} ${detailIndex + 1}`} />
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
              <span>필드 {capture.modal.fields.length} · 표 {capture.modal.tables.length}</span></summary>
            {capture.trigger.parentModalTitle && <p className="muted">{capture.trigger.parentModalTitle}에서 열림</p>}
            {capture.settling?.status === "timeout" && <p className="comparison-failures">값 로딩 확인 시간 초과 · 일부 값이 누락되었을 수 있습니다.</p>}
            <FieldList fields={capture.modal.fields} />
            <TableList tables={capture.modal.tables} group={capture.trigger.label} />
            {capture.modal.text && <div className="comparison-text-block"><h4>팝업 본문</h4><p>{capture.modal.text}</p></div>}
          </details>) : <p className="muted comparison-empty">수집된 클릭 상세 정보가 없습니다.</p>}
          {detail.modalDiscovery?.failures.length ? <p className="comparison-failures">수집 실패 {detail.modalDiscovery.failures.length}건: {detail.modalDiscovery.failures.join(" · ")}</p> : null}
        </section>
        {independent.length > 0 && <section className="comparison-group" aria-label="독립 상세 정보">
          <h3>참조 상세 정보 · {independent.length}개</h3>
          {independent.map((item) => <details className="comparison-card" key={`${item.kind}-${item.number}`} open>
            <summary>{item.kind} · {item.number}</summary>
            {item.detail ? <><FieldList fields={item.detail.fields} />
              <TableList tables={item.detail.tables} group={`${item.kind} ${item.number}`} /></>
              : <p className="muted comparison-empty">참조한 상세 정보가 없습니다.</p>}
          </details>)}
        </section>}
        <details className="raw-json"><summary>상세 수집 JSON 원문 보기</summary><pre>{JSON.stringify(detail, null, 2)}</pre></details>
      </> : <p className="muted comparison-empty">상세 페이지 수집 자료가 없습니다.</p>}
    </section>
    </div>
  </>;
}
