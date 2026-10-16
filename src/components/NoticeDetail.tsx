import type { FieldValue, NormalizedNotice } from "@/lib/g2b/normalize";
import type { ScrapedDetail } from "@/lib/g2b/detail-page";
import type { ApiNotice } from "@/lib/g2b/types";
import { apiFieldDisplayName } from "@/lib/g2b/api-field-labels";

function publicLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

function rawValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function RawFields({ fields, apiLabels = false }: { fields: Record<string, unknown>; apiLabels?: boolean }) {
  const entries = Object.entries(fields);
  if (!entries.length) return <p className="muted">수집된 항목이 없습니다.</p>;
  return <dl className="raw-fields">{entries.map(([name, value]) => {
    const display = rawValue(value);
    const href = typeof value === "string" ? publicLink(value) : null;
    return <div className="raw-field" key={name}>
      <dt>{apiLabels ? apiFieldDisplayName(name) : name}</dt>
      <dd>{display ? href ? <a href={href} target="_blank" rel="noopener noreferrer">{display}</a> : display : <span className="muted">값 없음</span>}</dd>
    </div>;
  })}</dl>;
}

function SourceComparison({ api, detail }: { api: ApiNotice; detail: ScrapedDetail | null }) {
  return <section className="detail-section source-comparison">
    <div className="section-heading"><span className="eyebrow">SOURCE DATA</span><h2>수집 데이터 비교</h2>
      <p>왼쪽은 API 공고 항목, 오른쪽은 나라장터 상세 화면에서 읽은 내용입니다. 비어 있는 API 항목도 표시합니다.</p>
    </div>
    <div className="source-columns">
      <section className="source-panel" aria-label="API 원본 데이터" tabIndex={0}>
        <div className="source-panel-header"><h3>API 원본 데이터</h3><span>{Object.keys(api).length}개 항목</span></div>
        <RawFields fields={api} apiLabels />
        <details className="raw-json"><summary>API JSON 원문 보기</summary><pre>{JSON.stringify(api, null, 2)}</pre></details>
      </section>
      <section className="source-panel" aria-label="나라장터 상세 수집 데이터" tabIndex={0}>
        <div className="source-panel-header"><h3>나라장터 상세 수집 데이터</h3><span>{Object.keys(detail?.fields || {}).length}개 항목</span></div>
        {detail ? <>
          <RawFields fields={detail.fields} />
          <div className="source-block"><h4>수집 본문 전체</h4><div className="source-text">{detail.text || <span className="muted">수집된 본문이 없습니다.</span>}</div></div>
          <div className="source-block"><h4>첨부파일 · {detail.attachments.length}개</h4>
            {detail.attachments.length ? <ul className="source-link-list">{detail.attachments.map((file, index) => {
              const href = file.url && publicLink(file.url);
              return <li key={`${file.name}-${index}`}>{href ? <a href={href} download>{file.name}</a> : file.name}</li>;
            })}</ul> : <p className="muted">수집된 첨부파일이 없습니다.</p>}
          </div>
          <div className="source-block"><h4>수집 링크 · {detail.links.length}개</h4>
            {detail.links.length ? <ul className="source-link-list">{detail.links.map((link, index) => {
              const href = publicLink(link.url);
              return <li key={`${link.url}-${index}`}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{link.label}</a> : link.label}</li>;
            })}</ul> : <p className="muted">수집된 링크가 없습니다.</p>}
          </div>
          <details className="raw-json"><summary>상세 수집 JSON 원문 보기</summary><pre>{JSON.stringify(detail, null, 2)}</pre></details>
        </> : <p className="muted source-empty">상세 페이지 수집 자료가 없습니다.</p>}
      </section>
    </div>
  </section>;
}

function Info({ label, field, wide = false, money = false }: { label: string; field: FieldValue; wide?: boolean; money?: boolean }) {
  const number = money && field.value ? Number(field.value.replaceAll(",", "").replace("원", "").trim()) : NaN;
  const display = money && Number.isFinite(number) ? `${number.toLocaleString("ko-KR")}원` : field.value;
  return <div className={wide ? "info-cell wide" : "info-cell"}>
    <dt>{label}{field.source && <span className="source-tag">{field.source === "api" ? "API" : "상세 페이지"}</span>}</dt>
    <dd>{display || <span className="muted">정보 없음</span>}</dd>
  </div>;
}

export function NoticeDetail({ notice, api, detail }: { notice: NormalizedNotice; api?: ApiNotice; detail?: ScrapedDetail | null }) {
  return <>
    <section className="detail-hero">
      <span className="eyebrow">SERVICE BID NOTICE</span>
      <h1>{notice.title.value || "제목 정보 없음"}</h1>
      <p>{notice.agency.value || "기관 정보 없음"}</p>
      <div className="detail-id">공고번호 {notice.number} <span>차수 {notice.order}</span></div>
    </section>

    {notice.scrapeStatus === "failed" && <div className="notice-warning">상세 페이지 수집에 실패했습니다. API에서 확인된 정보만 표시합니다.</div>}

    {api && <SourceComparison api={api} detail={detail || null} />}

    <section className="detail-section">
      <div className="section-heading"><span className="eyebrow">OVERVIEW</span><h2>주요 항목 요약</h2></div>
      <dl className="info-grid">
        <Info label="업무 내용" field={notice.description} wide />
        <Info label="수행 기간" field={notice.servicePeriod} />
        <Info label="금액" field={notice.amount} money />
        <Info label="참가 자격" field={notice.qualifications} wide />
        <Info label="지역" field={notice.region} />
        <Info label="공고 게시일" field={notice.postedAt} />
        <Info label="입찰 마감일" field={notice.deadline} />
      </dl>
    </section>

    <section className="detail-section">
      <div className="section-heading"><span className="eyebrow">DOCUMENTS</span><h2>첨부파일</h2></div>
      {notice.attachments.length ? <ul className="attachment-list">
        {notice.attachments.map((file) => <li key={`${file.name}-${file.url}`}><span aria-hidden="true">↧</span>
          <a href={file.url} download>{file.name}</a></li>)}
      </ul> : <p className="muted">확인된 첨부파일이 없습니다.</p>}
    </section>

    <a className="source-link" href={notice.originalUrl} target="_blank" rel="noopener noreferrer">나라장터 원문 보기 <span aria-hidden="true">↗</span></a>
  </>;
}
