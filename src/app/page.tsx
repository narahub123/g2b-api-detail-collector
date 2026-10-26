import { UserNoticeList } from "@/components/UserNoticeList";
import { listNotices } from "@/lib/g2b/notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 저장된 공고 목록을 사용자에게 읽기 전용으로 제공합니다. */
export default async function Home() {
  const notices = await listNotices();
  return <main className="site-shell">
    <header className="site-header"><div className="brand-mark">N</div><div><strong>나라장터 용역 공고</strong><span>LOCAL BID EXPLORER</span></div></header>
    <section className="page-intro"><span className="eyebrow">PROCUREMENT OVERVIEW</span>
      <h1>용역 공고를<br /><em>한눈에 살펴보세요.</em></h1>
      <p>업무 내용과 기간, 금액, 참가 조건을 확인하기 쉽게 모았습니다.</p>
    </section>
    <section className="results-section"><div className="results-heading"><div><span className="eyebrow">BID NOTICES</span><h2>공고 목록 <span>{notices.length}</span></h2></div><p>제목을 누르면 공고 상세 정보를 확인할 수 있습니다.</p></div>
      <UserNoticeList notices={notices} /></section>
    <footer>데이터 출처: 조달청 나라장터 입찰공고정보서비스 · 상세 정보는 원문을 함께 확인하세요.</footer>
  </main>;
}
