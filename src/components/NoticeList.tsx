import type { NormalizedNotice } from "@/lib/g2b/normalize";

function amount(value: string | null) {
  if (!value) return "금액 정보 없음";
  const number = Number(value.replaceAll(",", "").replace("원", "").trim());
  return Number.isFinite(number) ? `${number.toLocaleString("ko-KR")}원` : value;
}

export function NoticeList({ notices }: { notices: NormalizedNotice[] }) {
  if (notices.length === 0) return <div className="empty-state">
    <strong>저장된 공고가 없습니다</strong><p>위에서 공고 게시일 범위를 선택해 첫 수집을 시작하세요.</p>
  </div>;
  return <div className="notice-list">
    {notices.map((notice) => <article className="notice-card" key={notice.key}>
      <div className="notice-topline"><span className="notice-id">{notice.number} · {notice.order}차</span>
        <span className={notice.scrapeStatus === "succeeded" ? "status-pill" : "status-pill warning"}>
          {notice.scrapeStatus === "succeeded" ? "상세 수집 완료" : "상세 수집 실패"}
        </span></div>
      <h3><a href={`/bids/${encodeURIComponent(notice.key)}`}>{notice.title.value || "제목 정보 없음"}</a></h3>
      <p className="agency">{notice.agency.value || "기관 정보 없음"}</p>
      <div className="notice-facts">
        <span><small>게시</small>{notice.postedAt.value || "정보 없음"}</span>
        <span><small>마감</small>{notice.deadline.value || "정보 없음"}</span>
        <span><small>금액</small>{amount(notice.amount.value)}</span>
        <span><small>지역</small>{notice.region.value || "정보 없음"}</span>
      </div>
    </article>)}
  </div>;
}
