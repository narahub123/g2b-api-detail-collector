import { notFound } from "next/navigation";
import { NoticeComparison } from "@/components/NoticeComparison";
import { getNoticeRecord } from "@/lib/g2b/notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function BidComparisonPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const record = await getNoticeRecord(key);
  if (!record) notFound();
  return <main className="site-shell comparison-page">
    <header className="site-header"><a className="brand-link" href="/"><div className="brand-mark">N</div><div><strong>나라장터 용역 공고</strong><span>LOCAL BID EXPLORER</span></div></a></header>
    <a href={`/bids/${encodeURIComponent(key)}`} className="back-link">← 공고 상세로 돌아가기</a>
    <div className="comparison-heading"><span className="eyebrow">SOURCE COMPARISON</span><h1>API · 상세 정보 비교</h1>
      <p>{record.normalized.title.value || "제목 정보 없음"} · {record.normalized.number} · {record.normalized.order}차</p>
    </div>
    <NoticeComparison api={record.api} detail={record.detail} orderPlans={record.orderPlans}
      preSpecifications={record.preSpecifications} otherDetails={record.otherDetails} />
    <footer>데이터 출처: 조달청 나라장터 입찰공고정보서비스 · 상세 정보는 원문을 함께 확인하세요.</footer>
  </main>;
}
