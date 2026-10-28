import { CollectionForm } from "@/components/CollectionForm";
import { AutomationSettingsForm } from "@/components/AutomationSettingsForm";
import { NoticeList } from "@/components/NoticeList";
import { NoticeFilters } from "@/components/NoticeFilters";
import { NoticePagination } from "@/components/NoticePagination";
import { listNoticePage } from "@/lib/g2b/notices";
import { parseNoticeFilters, parseNoticePage } from "@/lib/g2b/notice-filters";
import "../notice-list-controls.css";
import "../automation-settings.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 공고 수집과 조건별 공고 목록·재수집 화면을 제공합니다. */
export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { values, filters, error } = parseNoticeFilters(params);
  const result = error ? null : await listNoticePage(filters, parseNoticePage(params.page));
  return <main className="site-shell">
    <header className="site-header"><a className="brand-link" href="/admin"><div className="brand-mark">N</div><div><strong>나라장터 용역 공고 관리</strong><span>LOCAL BID EXPLORER</span></div></a></header>
    <section className="page-intro"><span className="eyebrow">PROCUREMENT ADMIN</span>
      <h2>용역 공고를<em> 수집하고 관리하세요.</em></h2>
      <p>공고 게시일 범위로 수집하거나 저장된 공고를 다시 수집할 수 있습니다.</p>
    </section>
    <CollectionForm />
    <p><a href="/admin/collections">수집 작업 이력과 오류 진단 보기 →</a></p>
    <AutomationSettingsForm />
    <section className="results-section"><div className="results-heading"><div><span className="eyebrow">SAVED NOTICES</span><h2>수집된 공고 {result && <span>{result.totalCount}</span>}</h2></div><p>제목을 누르면 관리자 상세를 보고, 체크박스로 재수집할 공고를 선택할 수 있습니다.</p></div>
      <NoticeFilters basePath="/admin" values={values} error={error} />
      {result && <><NoticeList key={`${result.page}:${JSON.stringify(filters)}`} notices={result.notices} /><NoticePagination basePath="/admin" page={result.page} totalPages={result.totalPages} filters={filters} /></>}</section>
    <footer>데이터 출처: 조달청 나라장터 입찰공고정보서비스 · 상세 정보는 원문을 함께 확인하세요.</footer>
  </main>;
}
