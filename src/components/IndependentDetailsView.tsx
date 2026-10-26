import Link from "next/link";
import type { IndependentReference } from "@/lib/g2b/notices";
import type { ScrapedDetail } from "@/lib/g2b/detail-page";
import { NoticeUserView } from "./NoticeUserView";
import { contentSections } from "@/lib/g2b/content-sections";

/** 이미 저장된 독립 상세만 기존 공고 상세 렌더러를 재사용해 표시합니다. */
export function IndependentDetailsView({ references }: { references: IndependentReference[] }) {
  if (!references.length) {
    return <p className="notice-stage-pending">저장된 상세 정보가 없습니다.</p>;
  }
  return <div className="user-sections">{references.map((reference) => {
    if (reference.noticeKey) {
      return <p key={reference.number}>
        <Link href={`/bids/${encodeURIComponent(reference.noticeKey)}/view`}>{reference.number} 공고 상세 보기</Link>
      </p>;
    }
    if (!reference.detail) {
      return <p className="notice-stage-pending" key={reference.number}>
        {reference.number}: 저장된 상세 정보가 없습니다.
      </p>;
    }
    // 이전 형식은 현재 필드 구조로 읽을 수 없으므로 내용을 해석하지 않고 재수집을 안내합니다.
    if (reference.detail.schemaVersion !== 2 && reference.detail.schemaVersion !== 3) {
      return <p className="notice-stage-pending" key={reference.number}>
        {reference.number}: 이전 형식의 상세 정보입니다. 다시 수집해 주세요.
      </p>;
    }
    const detail: ScrapedDetail = {
      sourceUrl: "",
      attachments: [],
      links: [],
      sections: contentSections(reference.detail, reference.detail.title || reference.number)
    };
    return <div key={reference.number}><NoticeUserView detail={detail} /></div>;
  })}</div>;
}
