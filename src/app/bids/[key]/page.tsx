import { notFound } from "next/navigation";
import { NoticeDetail } from "@/components/NoticeDetail";
import { getNoticeRecord } from "@/lib/g2b/notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function BidPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const record = await getNoticeRecord(key);
  if (!record) notFound();
  return <main className="site-shell detail-page">
    <header className="site-header"><a className="brand-link" href="/"><div className="brand-mark">N</div><div><strong>나라장터 용역 공고</strong><span>LOCAL BID EXPLORER</span></div></a></header>
    <a href="/" className="back-link">← 목록으로 돌아가기</a>
    <NoticeDetail notice={record.normalized} api={record.api} detail={record.detail} />
    <footer>데이터 출처: 조달청 나라장터 입찰공고정보서비스 · 상세 정보는 원문을 함께 확인하세요.</footer>
  </main>;
}
