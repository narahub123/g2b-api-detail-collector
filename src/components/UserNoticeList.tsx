import type { NormalizedNotice } from "@/lib/g2b/normalize";

/** 사용자 목록에서 금액을 읽기 쉬운 원화 형식으로 표시합니다. */
function amount(value: string | null): string {
  if (!value) return "금액 정보 없음";
  const number = Number(value.replaceAll(",", "").replace("원", "").trim());
  return Number.isFinite(number) ? `${number.toLocaleString("ko-KR")}원` : value;
}

/** 저장된 공고의 요약과 사용자 상세 링크만 표시합니다. */
export function UserNoticeList({ notices }: { notices: NormalizedNotice[] }) {
  if (notices.length === 0) return <div className="empty-state">
    <strong>저장된 공고가 없습니다</strong><p>공고가 저장되면 이곳에서 확인할 수 있습니다.</p>
  </div>;

  return <div className="notice-list">{notices.map((notice) => <article className="notice-card" key={notice.key}>
    <div className="notice-topline"><span className="notice-id">{notice.number} · {notice.order}차</span></div>
    <h3><a href={`/bids/${encodeURIComponent(notice.key)}`}>{notice.title.value || "제목 정보 없음"}</a></h3>
    <p className="agency">{notice.agency.value || "기관 정보 없음"}</p>
    <div className="notice-facts">
      <span><small>게시</small>{notice.postedAt.value || "정보 없음"}</span>
      <span><small>마감</small>{notice.deadline.value || "정보 없음"}</span>
      <span><small>금액</small>{amount(notice.amount.value)}</span>
      <span><small>지역</small>{notice.region.value || "정보 없음"}</span>
    </div>
  </article>)}</div>;
}
