import type { FieldValue, NormalizedNotice } from "@/lib/g2b/normalize";

function Info({ label, field, wide = false, money = false }: { label: string; field: FieldValue; wide?: boolean; money?: boolean }) {
  const number = money && field.value ? Number(field.value.replaceAll(",", "").replace("원", "").trim()) : NaN;
  const display = money && Number.isFinite(number) ? `${number.toLocaleString("ko-KR")}원` : field.value;
  return <div className={wide ? "info-cell wide" : "info-cell"}>
    <dt>{label}{field.source && <span className="source-tag">{field.source === "api" ? "API" : "상세 페이지"}</span>}</dt>
    <dd>{display || <span className="muted">정보 없음</span>}</dd>
  </div>;
}

/** 정규화된 공고 요약과 관리자용 확인 링크를 표시합니다. */
export function NoticeDetail({ notice, relatedNoticeKeys = [], relatedNoticeStates = {} }: {
  notice: NormalizedNotice;
  relatedNoticeKeys?: string[];
  relatedNoticeStates?: Record<string, "failed" | "unavailable" | "succeeded">;
}) {
  return <>
    <section className="detail-hero">
      <span className="eyebrow">SERVICE BID NOTICE</span>
      <h1>{notice.title.value || "제목 정보 없음"}</h1>
      <p>{notice.agency.value || "기관 정보 없음"}</p>
      <div className="detail-id">공고번호 {notice.number} <span>차수 {notice.order}</span></div>
    </section>

    {notice.scrapeStatus === "failed" && <div className="notice-warning">상세 페이지 수집에 실패했습니다. API에서 확인된 정보만 표시합니다.</div>}

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

    {relatedNoticeKeys.length > 0 && <section className="detail-section" aria-label="관련 공고">
      <div className="section-heading"><span className="eyebrow">RELATED</span><h2>관련 공고</h2></div>
      <ul className="attachment-list">{relatedNoticeKeys.map((key) => {
        const [number, order] = key.split("--");
        return <li key={key}><a href={`/bids/${encodeURIComponent(key)}`}>{number} · {order}차</a>
          {relatedNoticeStates[key] === "failed" && <span className="muted"> · 수집 실패</span>}
          {relatedNoticeStates[key] === "unavailable" && <span className="muted"> · 상세 정보 없음</span>}
        </li>;
      })}</ul>
    </section>}

    <div className="detail-actions">
      <a className="source-link" href={`/bids/${encodeURIComponent(notice.key)}/view`}>사용자 화면 보기</a>
      <a className="source-link" href={`/bids/${encodeURIComponent(notice.key)}/compare`}>수집 정보 비교</a>
      <a className="source-link" href={notice.originalUrl} target="_blank" rel="noopener noreferrer">나라장터 원문 보기 <span aria-hidden="true">↗</span></a>
    </div>
  </>;
}
