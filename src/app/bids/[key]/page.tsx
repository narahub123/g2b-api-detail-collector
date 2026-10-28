import { notFound } from "next/navigation";
import { IndependentDetailsView } from "@/components/IndependentDetailsView";
import { NoticeUserView } from "@/components/NoticeUserView";
import { NoticeStageTabs } from "@/components/NoticeStageTabs";
import { RelatedNoticeLine } from "@/components/RelatedNoticeLine";
import { getNoticeRecord, listPublicNoticeKeys } from "@/lib/g2b/notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 저장된 공고의 상세 추출 결과를 사용자용 화면으로 제공합니다. */
export default async function BidUserViewPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const record = await getNoticeRecord(key);
  if (!record?.detail) notFound();
  // 사용자 화면의 관련 이동 링크도 공개된 공고에만 연결합니다.
  const publicKeys = new Set(await listPublicNoticeKeys([...new Set([...record.relatedNoticeKeys,
    ...record.otherDetails.flatMap((item) => item.noticeKey ? [item.noticeKey] : [])])]));
  const relatedKeys = record.relatedNoticeKeys.filter((relatedKey) => publicKeys.has(relatedKey));
  const otherDetails = record.otherDetails.map((item) => item.noticeKey && !publicKeys.has(item.noticeKey)
    ? { ...item, noticeKey: undefined } : item);
  return <main className="site-shell user-view-page">
    <header className="site-header"><a className="brand-link" href="/"><div className="brand-mark">N</div>
      <div><strong>나라장터 용역 공고</strong><span>LOCAL BID EXPLORER</span></div></a></header>
    <a href="/" className="back-link">← 공고 목록으로 돌아가기</a>
    <div className="user-view-heading"><span className="eyebrow">BID NOTICE</span>
      <h1>{record.normalized.title.value || "제목 정보 없음"}</h1>
      <p>수요기관: {record.normalized.demandAgency.value || "정보 없음"} · 공고번호 {record.normalized.number} · {record.normalized.order}차</p>
    </div>
    <NoticeStageTabs
      targets={{ currentKey: key, relatedKeys: [...new Set([...relatedKeys,
        ...otherDetails.flatMap((item) => item.noticeKey ? [item.noticeKey] : [])])],
        planNumbers: record.orderPlans.map((item) => item.number),
        specNumbers: record.preSpecifications.map((item) => item.number),
        opening: record.openingDetails.map((item) => ({ number: item.number, triggers: item.triggers })) }}
      plan={<IndependentDetailsView references={record.orderPlans} />}
      spec={<IndependentDetailsView references={record.preSpecifications} />}
      opening={record.openingDetails.length ? <IndependentDetailsView references={record.openingDetails} /> : undefined}>
      <RelatedNoticeLine currentKey={key} relatedKeys={relatedKeys} />
      <NoticeUserView detail={record.detail} />
    </NoticeStageTabs>
    <footer>데이터 출처: 조달청 나라장터 · 최종 참가 조건과 제출 내용은 원문 및 첨부파일을 확인하세요.</footer>
  </main>;
}
