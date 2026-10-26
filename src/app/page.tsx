import { UserNoticeList } from "@/components/UserNoticeList";
import { UserNoticeFilters } from "@/components/UserNoticeFilters";
import { UserNoticePagination } from "@/components/UserNoticePagination";
import { listUserNoticePage } from "@/lib/g2b/notices";
import { parseNoticeFilters, parseNoticePage } from "@/lib/g2b/notice-filters";
import "./user-notice-filters.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** URL 조건을 검증해 저장된 공고 목록을 사용자에게 제공합니다. */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { values, filters, error } = parseNoticeFilters(params);
  const result = error ? null : await listUserNoticePage(filters, parseNoticePage(params.page));
  return <main className="site-shell">
    <header className="site-header"><div className="brand-mark">N</div><div><strong>나라장터 용역 공고</strong><span>LOCAL BID EXPLORER</span></div></header>
    <section className="page-intro"><span className="eyebrow">PROCUREMENT OVERVIEW</span>
      <h2>용역 공고를<em> 한눈에 살펴보세요.</em></h2>
      <p>업무 내용과 기간, 금액, 참가 조건을 확인하기 쉽게 모았습니다.</p>
    </section>
    <section className="results-section"><div className="results-heading"><div><span className="eyebrow">BID NOTICES</span><h2>공고 목록 {result && <span>{result.totalCount}</span>}</h2></div><p>제목을 누르면 공고 상세 정보를 확인할 수 있습니다.</p></div>
      <UserNoticeFilters values={values} error={error} />
      {result && <><UserNoticeList notices={result.notices} /><UserNoticePagination page={result.page} totalPages={result.totalPages} filters={filters} /></>}</section>
    <footer>데이터 출처: 조달청 나라장터 입찰공고정보서비스 · 상세 정보는 원문을 함께 확인하세요.</footer>
  </main>;
}
