import {ArrowUpRight,Files,History} from 'lucide-react';

/** 관리자 이력 화면으로 이동하는 접근 가능한 공통 카드를 표시합니다. */
export function AdminHistoryCard({href,title,description,icon}:{href:string;title:string;description:string;icon:'collection'|'document'}){
 const Icon=icon==='collection'?History:Files;
 return <a className="admin-history-card" href={href}><span className="admin-history-icon"><Icon size={23} aria-hidden="true"/></span>
  <span className="admin-history-copy"><strong>{title}</strong><span>{description}</span></span><ArrowUpRight className="admin-history-arrow" size={20} aria-hidden="true"/></a>;
}
