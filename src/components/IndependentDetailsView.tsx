import Link from "next/link";
import type { IndependentReference } from "@/lib/g2b/notices";
import type { ScrapedDetail } from "@/lib/g2b/detail-page";
import { NoticeUserView } from "./NoticeUserView";

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
    const detail: ScrapedDetail = {
      sourceUrl: "",
      attachments: [],
      links: [],
      sections: [{
        title: reference.detail.title || reference.number,
        fields: reference.detail.fields,
        tables: reference.detail.tables
      }]
    };
    return <div key={reference.number}><NoticeUserView detail={detail} /></div>;
  })}</div>;
}
