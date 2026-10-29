import { notFound } from "next/navigation";
import { NoticeDetail } from "@/components/NoticeDetail";
import { getNoticeRecord } from "@/lib/g2b/notices";
import { PdfPocPanel } from "@/components/PdfPocPanel";
import { pocEnabled } from "@/lib/pdf-poc/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 저장된 공고의 요약과 수집 상태를 관리자에게 제공합니다. */
export default async function AdminBidPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const record = await getNoticeRecord(key);
  if (!record) notFound();
  const relatedNoticeStates = Object.fromEntries(await Promise.all(record.relatedNoticeKeys.map(async (relatedKey) => {
    const related = await getNoticeRecord(relatedKey);
    return [relatedKey, !related ? "unavailable" : related.normalized.scrapeStatus === "succeeded" ? "succeeded" : related.detailError ? "failed" : "unavailable"] as const;
  })));
  return <main className="site-shell detail-page">
    <header className="site-header"><a className="brand-link" href="/admin"><div className="brand-mark">N</div><div><strong>나라장터 용역 공고 관리</strong><span>LOCAL BID EXPLORER</span></div></a></header>
    <a href="/admin" className="back-link">← 관리자 목록으로 돌아가기</a>
    <NoticeDetail notice={record.normalized} relatedNoticeKeys={record.relatedNoticeKeys}
      relatedNoticeStates={relatedNoticeStates}
      collectionStatus={record.detail ? "succeeded" : record.detailError ? "failed" : "pending"} />
    {pocEnabled() && <PdfPocPanel noticeKey={key} attachments={record.detail?.attachments ?? []} />}
    <footer>데이터 출처: 조달청 나라장터 입찰공고정보서비스 · 상세 정보는 원문을 함께 확인하세요.</footer>
  </main>;
}
