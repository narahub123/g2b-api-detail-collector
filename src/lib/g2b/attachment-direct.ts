import {isFixedAttachmentExclusion} from './attachment-exclusions';
import {parseProposalUrl,proposalPath} from './attachment-proposal';

export type DownloadContext={kind:'notice'|'pre-specification'|'order-plan';number:string;order?:string;businessCode:string};
const paths={notice:'/pn/pnp/pnpe/UntyAtchFile/downloadFile.do','pre-specification':'/pn/pnz/pnza/UntyAtchFile/downloadFile.do','order-plan':'/pr/prp/prpa/UntyAtchFile/downloadFile.do'} as const;

/** 저장된 업무 명칭과 실제 응답의 코드를 같은 업무 코드로 해석합니다. */
export function businessCode(value:unknown):string|null{
 if(typeof value!=='string')return null;
 const codes:Record<string,string>={'일반용역':'03','기술용역':'05','물품(내자)':'01','물품':'01','공사':'02','외자':'06'};
 return Object.hasOwn(codes,value.trim())?codes[value.trim()]:(/^(01|02|03|05|06)$/.test(value)?value:null);
}

/** 수집된 업무 문맥과 실제 파일순서로만 직접 다운로드 주소를 구성합니다. */
export function buildDirectAttachmentUrl(context:DownloadContext,seq:number):string|null{
 if(!Number.isSafeInteger(seq)||seq<=0||!businessCode(context.businessCode))return null;
 const pattern=context.kind==='notice'?/^R\d{2}BK\d+$/:context.kind==='pre-specification'?/^R\d{2}BD\d+$/:/^R\d{2}DD\d+$/;
 if(!pattern.test(context.number)||(context.kind==='notice'&&!/^\d{3}$/.test(context.order??'')))return null;
 const url=new URL(paths[context.kind],'https://www.g2b.go.kr');
 if(context.kind==='notice'){url.searchParams.set('bidPbancNo',context.number);url.searchParams.set('bidPbancOrd',context.order!);}
 else url.searchParams.set(context.kind==='pre-specification'?'bfSpecRegNo':'oderPlanNo',context.number);
 url.searchParams.set('fileSeq',String(seq));url.searchParams.set('fileType',context.kind==='pre-specification'?'BFDTL':'');
 url.searchParams.set('prcmBsneSeCd',businessCode(context.businessCode)!);return url.toString();
}

/** 직접 다운로드를 허용할 나라장터 파일 주소를 검증합니다. */
export function validateDirectAttachmentUrl(value:string):string|null{
 if(parseProposalUrl(value))return value;
 try{const url=new URL(value);
  if(url.protocol!=='https:'||url.hostname!=='www.g2b.go.kr'||url.port||url.username||url.password||url.hash||!Object.values(paths).includes(url.pathname as typeof paths[keyof typeof paths]))return null;
  const kind=(Object.keys(paths) as (keyof typeof paths)[]).find(key=>paths[key]===url.pathname)!;
  const params=url.searchParams;
  if([...new Set(params.keys())].some(key=>params.getAll(key).length!==1))return null;
  if(!/^[1-9][0-9]*$/.test(params.get('fileSeq')??'')||!/^(01|02|03|05|06)$/.test(params.get('prcmBsneSeCd')??''))return null;
  const context:DownloadContext={kind,number:params.get(kind==='notice'?'bidPbancNo':kind==='pre-specification'?'bfSpecRegNo':'oderPlanNo')??'',order:params.get('bidPbancOrd')??undefined,businessCode:params.get('prcmBsneSeCd')??''};
  const canonical=buildDirectAttachmentUrl(context,Number(params.get('fileSeq')));
  if(!canonical||params.get('fileType')!==(kind==='pre-specification'?'BFDTL':''))return null;
  const expected=new URL(canonical).searchParams;
  if([...params.keys()].some(key=>!expected.has(key)))return null;
  return url.toString();
 }catch{return null;}
}

/** URL과 독립 식별 필드가 현재 공고의 같은 직접 첨부를 가리키는지 확인합니다. */
export function directAttachmentIdentity(key:string,file:{url?:unknown;fileNo?:unknown;seq?:unknown}):{key:string;fileNo:string;seq:number}|null{
 if(typeof file.fileNo!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(file.fileNo)||!Number.isSafeInteger(file.seq)||Number(file.seq)<=0||typeof file.url!=='string'||!validateDirectAttachmentUrl(file.url))return null;
 const url=new URL(file.url);
 if(isFixedAttachmentExclusion(file.fileNo,Number(file.seq)))return null;
 if(url.pathname===proposalPath){const identity=parseProposalUrl(file.url);return identity?.fileNo===file.fileNo&&identity.seq===file.seq?{key,fileNo:file.fileNo,seq:Number(file.seq)}:null;}
 if(url.pathname!==paths.notice||`${url.searchParams.get('bidPbancNo')}--${url.searchParams.get('bidPbancOrd')}`!==key||Number(url.searchParams.get('fileSeq'))!==file.seq)return null;
 return {key,fileNo:file.fileNo,seq:Number(file.seq)};
}
