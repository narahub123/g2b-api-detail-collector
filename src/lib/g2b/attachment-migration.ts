import {parseAttachmentDownloadUrl} from './attachment-links';
import {buildDirectAttachmentUrl,businessCode,type DownloadContext} from './attachment-direct';
import {isFixedAttachmentExclusion} from './attachment-exclusions';
export {isFixedAttachmentExclusion} from './attachment-exclusions';

type JsonObject=Record<string,unknown>;
export type MigrationNotice={key:string;notice_number:string;notice_order:string;api:JsonObject|null;detail:unknown};
export type MigrationIndependent={detail_key:string;category:string;payload:unknown};
export type AttachmentMapping={oldUrl:string;url:string;key:string;fileNo:string;seq:number;modalIndex?:number};
export type MigrationExclusion={url:string;reason:'fixed_exclusion'|'missing_context'|'conflicting_context'|'malformed_identity'|'unverified_file_group'};
export type AttachmentMigrationPlan={notices:{key:string;before:unknown;after:unknown}[];independent:{key:string;before:unknown;after:unknown}[];mappings:AttachmentMapping[];excluded:MigrationExclusion[]};


/** JSON 객체만 식별해 잘못된 입력을 제외합니다. */
function object(value:unknown):JsonObject|null{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:null;}

/** 첨부 배열이 아닌 값은 빈 배열로 취급합니다. */
function array(value:unknown):unknown[]{return Array.isArray(value)?value:[];}

/** 저장된 구조화 필드에서 유일한 업무구분을 찾습니다. */
function storedBusiness(value:unknown):string|null{
 const found=new Set<string>();
 /** 본문의 단순 언급을 제외하고 업무구분 필드만 참조합니다. */
 const visit=(node:unknown)=>{
  if(Array.isArray(node)){node.forEach(visit);return;}
  const item=object(node);if(!item)return;
  if(item.label==='업무구분'&&item.visible!==false){
   const text=array(item.value).map(object).filter(part=>part&&part.visible!==false).map(part=>String(part!.text??'')).join('').trim();
   const code=businessCode(text);if(code)found.add(code);
  }
  Object.values(item).forEach(visit);
 };
 visit(value);return found.size===1?[...found][0]:null;
}

/** 같은 자료에 첨부 식별자가 저장된 경우에만 대응을 인정합니다. */
function hasFile(payload:unknown,fileNo:string,seq:number):boolean{
 return array(object(payload)?.attachments).some(value=>{
  const item=object(value);if(!item||typeof item.url!=='string')return false;
  const identity=parseAttachmentDownloadUrl(item.url);
  return identity?.fileNo===fileNo&&identity.seq===seq||item.fileNo===fileNo&&item.seq===seq;
 });
}

/** 공고의 주 첨부 표와 유일하게 대응한 묶음만 일반 공고 다운로드로 변환합니다. */
function noticeFileGroups(detail:JsonObject):Set<string>{
 const names=new Set<string>();
 for(const raw of array(detail.sections)){
  const section=object(raw);if(section?.title!=='파일첨부')continue;
  for(const tableValue of array(section.tables)){
   const table=object(tableValue);if(!table)continue;
   if(typeof table.sourceId==='string'&&!/_grdFile_body_table$/.test(table.sourceId))continue;
   for(const row of array(table.bodyRows))for(const cellValue of array(row)){
    const cell=object(cellValue);if(typeof cell?.value==='string')names.add(cell.value.replace(/\s+/g,' ').trim());
   }
  }
 }
 const files=array(detail.attachments).flatMap(raw=>{
  const file=object(raw),id=typeof file?.url==='string'?parseAttachmentDownloadUrl(file.url):null;
  return file&&id&&typeof file.name==='string'?[{name:file.name.replace(/\s+/g,' ').trim(),fileNo:id.fileNo}]:[];
 });
 return new Set(files.filter(file=>names.has(file.name)&&new Set(files.filter(other=>other.name===file.name).map(other=>other.fileNo)).size===1).map(file=>file.fileNo));
}

/** 외부 요청 없이 기존 첨부 참조에 적용할 변환 차이를 만듭니다. */
export function planAttachmentMigration(notices:MigrationNotice[],independent:MigrationIndependent[]):AttachmentMigrationPlan{
 const noticeByKey=new Map(notices.map(item=>[item.key,item]));
 const independentByNumber=new Map(independent.map(item=>[String(object(item.payload)?.number??item.detail_key),item]));
 const mappings=new Map<string,AttachmentMapping>(),excluded=new Map<string,MigrationExclusion>();
 /** 공개 API 주소를 사용하지 않고 저장된 분류명과 공고번호로 문맥을 만듭니다. */
 const noticeContext=(notice:MigrationNotice):DownloadContext|null=>{
  const code=businessCode(notice.api?.srvceDivNm)||storedBusiness(object(notice.detail)?.sections);
  return code&&notice.notice_number&&notice.notice_order!=null?{kind:'notice',number:notice.notice_number,order:notice.notice_order,businessCode:code}:null;
 };
 /** 정상 식별자와 유일한 문맥만 변환하며 원본 JSON을 변경하지 않습니다. */
 const propose=(value:unknown,context:DownloadContext|null)=>{
  const item=object(value);if(!item||typeof item.url!=='string'||!item.url.startsWith('/api/attachments/'))return;
  const oldUrl=item.url,identity=parseAttachmentDownloadUrl(oldUrl);
  if(!identity){excluded.set(oldUrl,{url:oldUrl,reason:'malformed_identity'});return;}
  if(isFixedAttachmentExclusion(identity.fileNo,identity.seq)){excluded.set(oldUrl,{url:oldUrl,reason:'fixed_exclusion'});return;}
  if(excluded.get(oldUrl)?.reason==='conflicting_context')return;
  const url=context?buildDirectAttachmentUrl(context,identity.seq):null;
  if(!url){if(!mappings.has(oldUrl))excluded.set(oldUrl,{url:oldUrl,reason:'missing_context'});return;}
  const prior=mappings.get(oldUrl);
  if(prior&&prior.url!==url){mappings.delete(oldUrl);excluded.set(oldUrl,{url:oldUrl,reason:'conflicting_context'});return;}
  excluded.delete(oldUrl);mappings.set(oldUrl,{oldUrl,url,...identity});
 };
 for(const notice of notices){
  const detail=object(notice.detail);if(!detail)continue;
  const context=noticeContext(notice);
  const mainGroups=noticeFileGroups(detail);
  for(const item of array(detail.attachments)){
   const raw=object(item),identity=typeof raw?.url==='string'?parseAttachmentDownloadUrl(raw.url):null;
   if(identity&&context&&!isFixedAttachmentExclusion(identity.fileNo,identity.seq)&&!mainGroups.has(identity.fileNo)){
    excluded.set(String(raw!.url),{url:String(raw!.url),reason:'unverified_file_group'});continue;
   }
   propose(item,identity?.key===notice.key&&identity.modalIndex===undefined?context:null);
  }
  for(const source of array(detail.modalAttachmentSources)){
   const item=object(source);if(!item)continue;
   const identity=typeof item.url==='string'?parseAttachmentDownloadUrl(item.url):null;
   const last=object(array(item.path).at(-1));let modalContext:DownloadContext|null=null;
   if(identity&&last){
    if(last.label==='입찰공고번호'&&typeof last.value==='string'){
     const linked=noticeByKey.get(last.value.replace(/-(\d{3})$/,'--$1'));
     if(linked&&noticeFileGroups(object(linked.detail)??{}).has(identity.fileNo))modalContext=noticeContext(linked);
    }else{
     const stored=independentByNumber.get(String(last.value));const payload=object(stored?.payload);
     const code=payload?storedBusiness(payload):null;
     if(stored&&payload&&code&&hasFile(payload,identity.fileNo,identity.seq)){
      const kind=stored.category==='pre-specification'?'pre-specification':stored.category==='order-plan'?'order-plan':null;
      if(kind)modalContext={kind,number:String(payload.number??stored.detail_key),businessCode:code};
     }
    }
   }
   propose(item,modalContext);
  }
 }
 for(const stored of independent){
  const payload=object(stored.payload),code=payload?storedBusiness(payload):null;
  const kind=stored.category==='pre-specification'?'pre-specification':stored.category==='order-plan'?'order-plan':null;
  const context:DownloadContext|null=payload&&code&&kind?{kind,number:String(payload.number??stored.detail_key),businessCode:code}:null;
  for(const item of array(payload?.attachments))propose(item,context);
 }
 /** 수집 참조에서 빠진 중첩 첨부도 누락 보고서에 남깁니다. */
 const findUnmapped=(value:unknown)=>{
  if(Array.isArray(value)){value.forEach(findUnmapped);return;}
  const node=object(value);if(!node)return;
  if(typeof node.url==='string'&&node.url.startsWith('/api/attachments/')&&(typeof node.name==='string'||Array.isArray(node.path))&&!mappings.has(node.url)&&!excluded.has(node.url)){
   const identity=parseAttachmentDownloadUrl(node.url);
   excluded.set(node.url,{url:node.url,reason:identity?(isFixedAttachmentExclusion(identity.fileNo,identity.seq)?'fixed_exclusion':'missing_context'):'malformed_identity'});
  }
  Object.values(node).forEach(findUnmapped);
 };
 notices.forEach(row=>findUnmapped(row.detail));independent.forEach(row=>findUnmapped(row.payload));
 /** 첨부 객체만 재귀 변환하고 본문·HTML·일반 링크 문자열은 보존합니다. */
 const rewrite=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(rewrite);
  const node=object(value);if(!node)return value;
  const updated=Object.fromEntries(Object.entries(node).map(([key,item])=>[key,rewrite(item)]));
  if(typeof node.url==='string'&&(typeof node.name==='string'||Array.isArray(node.path))){
   const mapping=mappings.get(node.url);
   if(mapping){updated.url=mapping.url;updated.fileNo=mapping.fileNo;updated.seq=mapping.seq;
    if(Array.isArray(node.path)&&mapping.modalIndex!==undefined)updated.modalIndex=mapping.modalIndex;}
  }
  return updated;
 };
 const plan:AttachmentMigrationPlan={notices:[],independent:[],mappings:[...mappings.values()],excluded:[...excluded.values()]};
 for(const row of notices){const after=rewrite(row.detail);if(JSON.stringify(row.detail)!==JSON.stringify(after))plan.notices.push({key:row.key,before:row.detail,after});}
 for(const row of independent){const after=rewrite(row.payload);if(JSON.stringify(row.payload)!==JSON.stringify(after))plan.independent.push({key:row.detail_key,before:row.payload,after});}
 return plan;
}
