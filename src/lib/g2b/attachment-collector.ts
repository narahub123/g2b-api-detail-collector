import * as cheerio from "cheerio";
import {resolveAttachmentHref} from './attachment-links';
import {buildDirectAttachmentUrl,directAttachmentIdentity} from './attachment-direct';
import type { Attachment, AttachmentMetadata, ClickDownload } from "./detail-page";

type AttachmentCollectionOptions = {
  baseUrl?: string;
  noticeKey?: string;
  fileMetadata?: AttachmentMetadata[];
  clickDownloads?: ClickDownload[];
  modalIndex?: number;
  includeOtherLinks?: boolean;
};

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * 상세페이지와 모달의 파일 셀을 같은 우선순위로 해석해 확인된 URL을 수집합니다.
 * 직접 href와 파일 묶음에 대응하는 업무 문맥을 사용하며 부모 공고나 파일명만으로 주소를 추측하지 않습니다.
 * @param html 현재 화면의 HTML
 * @param options 기준 URL과 실제 수집한 파일 식별 자료
 * @returns 파일명과 확인된 다운로드 URL
 */
export function collectAttachments(html: string, options: AttachmentCollectionOptions): Attachment[] {
  const $ = cheerio.load(html);
  const attachments: Attachment[] = [];
  const seen = new Set<string>();
  const metadata = options.fileMetadata || [];
  const clicks = new Map((options.clickDownloads || []).map((file) => [file.cellId, file]));
  /** 같은 이름의 다른 파일은 묶음 번호와 실제 순서로 구분합니다. */
  const add = (name: string, url: string | null, fileNo?:string,seq?:number): void => {
    const identity = `${name}\u0000${fileNo||''}\u0000${seq??''}\u0000${url || ""}`;
    if (!name || seen.has(identity)) return;
    attachments.push({ name, url,...(fileNo?{fileNo}:{}),...(seq?{seq}:{}) });
    seen.add(identity);
  };
  // 동일한 파일명이라도 셀별 식별자가 다르면 별도 첨부로 유지합니다.
  $("td[col_id='orgnlAtchFileNm']").each((_, cell) => {
    const element = $(cell);
    const name = clean(element.text());
    if (!name) return;
    const direct = resolveAttachmentHref(element.find("a[href]").first().attr("href"), options.baseUrl);
    const click = clicks.get(element.attr("id") || "");
    const verifiedClick=click?.name===name?click:undefined;
    const sameName=metadata.filter(file=>clean(cheerio.load(file.orgnlAtchFileNm).text())===name);
    const unidentifiedClick=element.find('a,button').length>0&&!direct&&!verifiedClick;
    const file=verifiedClick||unidentifiedClick?undefined:sameName.length===1?sameName[0]:undefined;
    const context=verifiedClick?.context??file?.context;
    const seq=verifiedClick?.seq??file?.atchFileSqno;
    const fileNo=verifiedClick?.fileNo??file?.untyAtchFileNo;
    const generated=context&&seq&&fileNo?buildDirectAttachmentUrl(context,seq):null;
    const proposal=verifiedClick?.downloadUrl&&options.noticeKey&&directAttachmentIdentity(options.noticeKey,{url:verifiedClick.downloadUrl,fileNo,seq})?verifiedClick.downloadUrl:null;
    add(name,proposal||direct||generated,fileNo,seq);
  });
  // 모달에는 표 밖에도 실제 파일 href가 있으므로 확인된 링크만 함께 담습니다.
  if (options.includeOtherLinks) $("a[href]").each((_, anchor) => {
    const element = $(anchor);
    if (element.closest("td[col_id='orgnlAtchFileNm']").length) return;
    const name = clean(element.text());
    const fileCell = /file|atch|첨부/i.test(element.closest("td").attr("col_id") || "");
    if (!name || !(fileCell || element.is("[download]") || /\.[a-z0-9]{2,8}$/i.test(name))) return;
    const url = resolveAttachmentHref(element.attr("href"), options.baseUrl);
    if (url) add(name, url);
  });
  // 파일 표가 늦게 렌더링되어도 별도로 받은 첨부 목록은 보존합니다.
  for (const file of metadata) {
    if (file.scrnIndtYn === "N") continue;
    const name = clean(cheerio.load(file.orgnlAtchFileNm).text());
    if(name&&!attachments.some(item=>file.untyAtchFileNo?item.fileNo===file.untyAtchFileNo&&item.seq===file.atchFileSqno:item.name===name))
      add(name,file.context&&file.untyAtchFileNo?buildDirectAttachmentUrl(file.context,file.atchFileSqno):null,file.untyAtchFileNo,file.atchFileSqno);
  }
  return attachments;
}
