import { ExternalLink } from "lucide-react";

/** 원문 주소를 안내하며 새 탭으로 여는 접근 가능한 아이콘 링크를 표시합니다. */
export function NoticeSourceLink({ href }: { href: string }) {
  return <a className="user-download-link notice-source-link" href={href}
    target="_blank" rel="noopener noreferrer" title="나라장터 원문 보기" aria-label="나라장터 원문 보기">
    <ExternalLink size={14} aria-hidden="true" />
  </a>;
}
