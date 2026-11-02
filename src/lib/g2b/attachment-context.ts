import type {Page} from 'playwright-core';
import {businessCode,type DownloadContext} from './attachment-direct';

const fileNumber=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type Registry={contexts:Map<string,DownloadContext[]>;pending:Promise<void>[]};
const registries=new WeakMap<Page,Registry>();

/** 실제 상세 응답의 업무 문맥을 파일 묶음에 연결하며 부모 화면의 값을 상속하지 않습니다. */
export function recordAttachmentContexts(registry:Map<string,DownloadContext[]>,path:string,body:unknown):void{
 if(!body||typeof body!=='object')return;
 const visit=(value:unknown):void=>{
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach(visit);return;}
  const row=value as Record<string,unknown>,code=businessCode(row.prcmBsneSeCd);
  let context:DownloadContext|undefined;
  if(code&&path.includes('selectBidAtchFileChkList.do')&&typeof row.bidPbancNo==='string'&&typeof row.bidPbancOrd==='string')
   context={kind:'notice',number:row.bidPbancNo,order:row.bidPbancOrd,businessCode:code};
  else if(code&&path.includes('selectBfSpec.do')&&typeof row.bfSpecRegNo==='string')
   context={kind:'pre-specification',number:row.bfSpecRegNo,businessCode:code};
  else if(code&&path.includes('selectOderPlan.do')&&typeof row.oderPlanNo==='string')
   context={kind:'order-plan',number:row.oderPlanNo,businessCode:code};
  if(context){
   // 연관 제안요청서 묶음은 같은 순서라도 다른 파일이므로 현재 화면의 직접 첨부만 연결합니다.
   const groupKey=context.kind==='notice'?'itemPbancUntyAtchFileNo':context.kind==='order-plan'?'oderPlanUntyAtchFileNo':'untyAtchFileNo';
   for(const [key,v] of Object.entries(row))if(key===groupKey&&typeof v==='string'){
    for(const no of v.split(',').map(x=>x.trim()).filter(x=>fileNumber.test(x))){
     const existing=registry.get(no)??[];
     if(!existing.some(item=>JSON.stringify(item)===JSON.stringify(context)))registry.set(no,[...existing,context]);
    }
   }
  }
  Object.values(row).forEach(visit);
 };
 visit(body);
}

/** 페이지 생성 직후 응답 감시를 시작하며 같은 페이지에서는 중복 리스너를 만들지 않습니다. */
export function observeAttachmentContexts(page:Page):void{
 if(registries.has(page))return;
 const registry:Registry={contexts:new Map(),pending:[]};registries.set(page,registry);
 page.on('response',response=>{
  const path=new URL(response.url()).pathname;
  if(!/selectBidAtchFileChkList[.]do|selectBfSpec[.]do|selectOderPlan[.]do/.test(path))return;
  registry.pending.push(response.json().then(body=>recordAttachmentContexts(registry.contexts,path,body)).catch(()=>undefined));
 });
}

/** 응답 읽기가 끝난 뒤 해당 파일 묶음의 유일한 문맥만 반환합니다. */
export async function attachmentContext(page:Page,fileNo:string):Promise<DownloadContext|undefined>{
 const registry=registries.get(page);if(!registry)return;
 await Promise.all(registry.pending);
 const candidates=registry.contexts.get(fileNo);
 return candidates?.length===1?candidates[0]:undefined;
}
