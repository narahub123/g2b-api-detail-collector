export const proposalPath='/fs/fsc/fsca/fileUpload.do';
export type ProposalFile={untyAtchFileNo:string;atchFileSqno:number;orgnlAtchFileNm:string;atchFilePathNm:string;scrnIndtYn?:string};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const inserts:[number,string][]=[[8,'r'],[6,'a'],[9,'o'],[7,'n'],[8,'w'],[6,'i'],[9,'z']];

/** 브라우저와 서버에서 같은 공개 첨부 파라미터 직렬화를 사용합니다. */
function encode(text:string):string{
 let result=btoa(Array.from(new TextEncoder().encode(text),byte=>String.fromCharCode(byte)).join(''));
 for(const [index,char] of inserts)result=result.slice(0,index)+char+result.slice(index);
 return result.replaceAll('+','%2B');
}

/** 조회된 공개 제안요청 파일만 재사용 가능한 실제 GET 주소로 만듭니다. */
export function buildProposalUrl(file:ProposalFile):string|null{
 if(!uuid.test(file.untyAtchFileNo)||!Number.isSafeInteger(file.atchFileSqno)||file.atchFileSqno<=0||file.scrnIndtYn==='N'||
  !/^\/data\/Attachfiles\/prpc\/[A-Za-z0-9_./-]+$/.test(file.atchFilePathNm)||file.atchFilePathNm.includes('..')||
  !file.orgnlAtchFileNm||/[\x00-\x1f\x7f]/.test(file.orgnlAtchFileNm))return null;
 const entries=[['kc','c11'],['k01','1'],['k12',file.untyAtchFileNo],['k05','0'],['k26',file.atchFilePathNm],['k31',file.orgnlAtchFileNm],['k21',file.untyAtchFileNo],['fileSeq',String(file.atchFileSqno)]];
 const url=new URL(proposalPath,'https://www.g2b.go.kr');
 url.searchParams.set('k00',encode(entries.map(([key,value])=>`${key}\f${value}`).join('\x0b')));
 url.searchParams.set('fileNo',file.untyAtchFileNo);
 // 본문 프로토콜에 없는 순번도 주소에 남겨 DB 식별자와 대조합니다.
 url.searchParams.set('fileSeq',String(file.atchFileSqno));return url.toString();
}

/** 정규 직렬화와 파일 식별자를 모두 확인해 임의 경로나 파라미터를 거부합니다. */
export function parseProposalUrl(value:string):{fileNo:string;seq:number}|null{
 try{
  const url=new URL(value);
  if(url.origin!=='https://www.g2b.go.kr'||url.pathname!==proposalPath||url.username||url.password||url.hash||
   [...url.searchParams.keys()].length!==3||url.searchParams.getAll('k00').length!==1||url.searchParams.getAll('fileNo').length!==1||url.searchParams.getAll('fileSeq').length!==1)return null;
  let encoded=(url.searchParams.get('k00')??'').replaceAll('%2B','+');
  for(const [index,char] of [...inserts].reverse()){if(encoded[index]!==char)return null;encoded=encoded.slice(0,index)+encoded.slice(index+1);}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(encoded),char=>char.charCodeAt(0)));
  const parts=text.split('\x0b').map(part=>part.split('\f'));
  if(parts.length!==8||parts.some(part=>part.length!==2))return null;
  const entries=Object.fromEntries(parts),seq=Number(url.searchParams.get('fileSeq'));
  const canonical=buildProposalUrl({untyAtchFileNo:entries.k21,atchFileSqno:seq,orgnlAtchFileNm:entries.k31,atchFilePathNm:entries.k26});
  return canonical===value&&entries.fileSeq===String(seq)&&url.searchParams.get('fileNo')===entries.k21?{fileNo:entries.k21,seq}:null;
 }catch{return null;}
}

/** 공개 메타데이터를 HTTP로 조회하고 다른 파일번호·중복 순번·비공개 자료를 거부합니다. */
export async function fetchProposalFiles(fileNo:string,signal?:AbortSignal,fetcher:typeof fetch=fetch):Promise<ProposalFile[]>{
 if(!uuid.test(fileNo))throw new Error('제안요청 파일번호가 올바르지 않습니다.');
 const timeout=AbortSignal.timeout(20000);
 const response=await fetcher('https://www.g2b.go.kr/fs/fsc/fscb/UntyAtchFile/selectUntyAtchFileList.do',{
  method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,headers:{'content-type':'application/json'},
  body:JSON.stringify({dlUntyAtchFileM:{untyAtchFileNo:fileNo,bsnePath:'prpc',bsneClsfCd:'업130026',tblNm:'DMND_RFP_ATCH_FILE',colNm:'RFP_UNTY_ATCH_FILE_NO',webPathUse:'N',viewMode:'view'}}),
 });
 if(!response.ok)throw new Error('제안요청 첨부 조회에 실패했습니다.');
 const body=await response.json();
 if(body.ErrorCode!==0||!Array.isArray(body.dlUntyAtchFileL)||!body.dlUntyAtchFileL.length)throw new Error('제안요청 첨부 조회 결과가 없습니다.');
 const files=body.dlUntyAtchFileL as ProposalFile[],seen=new Set<number>();
 for(const file of files){
  if(!file||file.untyAtchFileNo!==fileNo||!Number.isSafeInteger(file.atchFileSqno)||file.atchFileSqno<=0||
   (file.scrnIndtYn!=='N'&&!buildProposalUrl(file))||seen.has(file.atchFileSqno))throw new Error('제안요청 첨부 식별자가 중복되거나 공개 정보가 올바르지 않습니다.');
  seen.add(file.atchFileSqno);
 }
 return files.filter(file=>file.scrnIndtYn!=='N');
}
