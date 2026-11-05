import {Readable} from 'node:stream';
import {createDownloadMeasure,type DownloadMeasure} from '../documents/download-timings';
import {ExtractionError} from '../documents/diagnostics';
import { PDF_MAX_BYTES } from "@/lib/documents/constants";
import {assertNotMaintenance,maintenanceFromError} from './maintenance';
import {parseAttachmentDownloadUrl} from './attachment-links';
import {validateDirectAttachmentUrl} from './attachment-direct';
import {getNoticeRecord} from './notices';
import type {Attachment,ModalTriggerStep} from './detail-page';

export type OpenedDownload={filename:string;stream:Readable;cleanup:()=>Promise<void>;contentType?:string};
type DownloadDependencies={
 load:(key:string)=>Promise<{detail:{attachments:Attachment[];modalAttachmentSources?:{
  url:string;fileNo?:string;seq?:number;modalIndex?:number;path:ModalTriggerStep[];
 }[]}|null}|null>;
 open:(url:string,signal:AbortSignal)=>Promise<OpenedDownload>;
};

/** 응답의 파일명을 해석하되 경로와 제어 문자는 파일명에 남기지 않습니다. */
function downloadFilename(header:string|null):string{
 const encoded=/filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header||'')?.[1];
 const ordinary=/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(header||'');
 let name=encoded||ordinary?.[1]||ordinary?.[2]||'attachment';
 try{name=decodeURIComponent(name);}catch{/* 잘못 인코딩된 이름은 원래 표시를 유지합니다. */}
 return name.replace(/[\\/\r\n\x00-\x1f]/g,'_').trim()||'attachment';
}

/** 검증된 직접 주소를 받아 수신 전체에 시간·크기·취소 제한을 적용합니다. */
export async function openHttpDownload(url:string,signal:AbortSignal,
 measure:DownloadMeasure=createDownloadMeasure(),fetcher:typeof fetch=fetch):Promise<OpenedDownload>{
 let current=validateDirectAttachmentUrl(url);
 if(!current)throw new ExtractionError('attachment_unavailable','직접 첨부 다운로드 주소가 올바르지 않습니다.');
 const controller=new AbortController();
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 let stream:Readable|undefined;
 let stopped=false,settled=false;
 let receiveResolve:(()=>void)|undefined,receiveReject:((error:unknown)=>void)|undefined;
 let receiving:Promise<void>|undefined;
 /** 취소 사유를 보존하며 대기 중인 헤더와 본문 읽기를 함께 깨웁니다. */
 const abort=()=>controller.abort(new ExtractionError('download_cancelled','다운로드 요청이 취소되었습니다.'));
 signal.addEventListener('abort',abort,{once:true});
 if(signal.aborted)abort();
 const timer=setTimeout(()=>controller.abort(new ExtractionError('download_timeout','다운로드 시간 초과')),120000);
 const cancelled=new Promise<never>((_resolve,reject)=>{
  const rejectAbort=()=>{
   reject(controller.signal.reason);void reader?.cancel().catch(()=>undefined);
   if(stream){stream.destroy(controller.signal.reason);void finish(controller.signal.reason).then(cleanup);}
  };
  controller.signal.addEventListener('abort',rejectAbort,{once:true});
  if(controller.signal.aborted)rejectAbort();
 });
 void cancelled.catch(()=>undefined);
 /** 정상 완료와 실패 모두 계측을 한 번만 마감합니다. */
 const finish=async(error?:unknown)=>{
  if(!settled){settled=true;if(error)receiveReject?.(error);else receiveResolve?.();}
  await receiving?.catch(()=>undefined);
 };
 /** 본문 취소와 타이머 해제는 반복 호출되어도 한 번만 수행합니다. */
 const cleanup=async()=>{
  if(stopped)return;stopped=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
  if(!settled)await finish(new ExtractionError('download_cancelled','파일 수신이 완료 전에 정리되었습니다.'));
  await reader?.cancel().catch(()=>undefined);
  reader?.releaseLock();
 };
 /** 네트워크 오류는 취소·크기 제한 같은 구체적인 사유를 덮어쓰지 않습니다. */
 const failure=(error:unknown):unknown=>controller.signal.aborted?controller.signal.reason:
  error instanceof ExtractionError||maintenanceFromError(error)?error:new ExtractionError('connection_failed','첨부파일 다운로드 연결에 실패했습니다.',{cause:error});
 try{
  const response=await measure('request',async()=>{
   for(let redirects=0;;redirects++){
    const result=await Promise.race([fetcher(current!,{signal:controller.signal,redirect:'manual'}),cancelled]);
    if(![301,302,303,307,308].includes(result.status))return result;
    await result.body?.cancel();
    if(redirects>=3)throw new ExtractionError('download_response','다운로드 리다이렉트 제한을 초과했습니다.');
    const location=result.headers.get('location');let next:string|null=null;
    try{next=location?validateDirectAttachmentUrl(new URL(location,current!).toString()):null;}catch{/* 손상된 이동 주소는 유효하지 않은 첨부로 처리합니다. */}
    if(!next)throw new ExtractionError('attachment_unavailable','다운로드 이동 주소가 올바르지 않습니다.');
    current=next;
   }
  });
  if(Number(response.headers.get('content-length'))>PDF_MAX_BYTES){await response.body?.cancel();throw new ExtractionError('size_limit','다운로드가 50MiB 크기 제한을 초과했습니다.');}
  if(!response.body)throw new ExtractionError('download_response','다운로드 파일 본문이 없습니다.');
  reader=response.body.getReader();
  receiving=measure('receive',()=>new Promise<void>((resolve,reject)=>{receiveResolve=resolve;receiveReject=reject;}));
  void receiving.catch(()=>undefined);
  const first=await Promise.race([reader.read(),cancelled]);
  const prefetched:Uint8Array[]=first.done?[]:[first.value];
  if(first.value&&first.value.length>PDF_MAX_BYTES)throw new ExtractionError('size_limit','다운로드가 50MiB 크기 제한을 초과했습니다.');
  const contentType=response.headers.get('content-type')||'application/octet-stream';
  let prefix=Buffer.from(first.value?.subarray(0,65536)||[]).toString('utf8');
  if(!response.ok||/text\/html|application\/(?:json|problem\+json)/i.test(contentType)||/^\s*</.test(prefix)){
   const parts=[Buffer.from(first.value?.subarray(0,65536)||[])];let prefixSize=parts[0].length;
   // 오류 화면은 제한된 앞부분만 합쳐 분할된 점검 문구를 놓치지 않습니다.
   while(!first.done&&prefixSize<65536){const part=await Promise.race([reader.read(),cancelled]);if(part.done)break;prefetched.push(part.value);const bytes=Buffer.from(part.value.subarray(0,65536-prefixSize));parts.push(bytes);prefixSize+=bytes.length;}
   prefix=Buffer.concat(parts).toString('utf8');
  }
  assertNotMaintenance(prefix,'download');
  if(!response.ok)throw new ExtractionError(response.status===429||response.status>=500?'download_http_retry':'download_response',`파일 다운로드 HTTP 오류 (${response.status})`);
  if(/(?:text\/html|application\/(?:json|problem\+json))/i.test(contentType)||/^\s*<(?:!doctype|html|head|title)(?:\s|>)/i.test(prefix))
   throw new ExtractionError('download_response','파일 대신 안내 또는 오류 응답을 받았습니다.');
  if(first.done)throw new ExtractionError('download_response','다운로드 파일 본문이 비어 있습니다.');
  const bodyReader=reader;
  // 소비자가 읽는 속도에 맞춰 본문을 전달하므로 파일 전체를 중복 버퍼링하지 않습니다.
  stream=Readable.from((async function*(){
   let total=0,index=1;let chunk:ReadableStreamReadResult<Uint8Array>=first;
   try{
    while(!chunk.done){
     if(controller.signal.aborted)throw controller.signal.reason;
     total+=chunk.value.length;
     if(total>PDF_MAX_BYTES)throw new ExtractionError('size_limit','다운로드가 50MiB 크기 제한을 초과했습니다.');
     yield Buffer.from(chunk.value);
     chunk=index<prefetched.length?{done:false,value:prefetched[index++]}:await Promise.race([bodyReader.read(),cancelled]);
    }
    if(controller.signal.aborted)throw controller.signal.reason;
    await finish();
   }catch(error){const reason=failure(error);await finish(reason);throw reason;}
   finally{await cleanup();}
  })());
  // 소비 시작 전 제한 시간이 지나도 처리되지 않은 스트림 오류로 프로세스를 종료하지 않습니다.
  stream.once('error',()=>{});
  stream.once('close',()=>{void cleanup();});
  return {filename:downloadFilename(response.headers.get('content-disposition')),contentType,stream,cleanup};
 }catch(error){const reason=failure(error);await finish(reason);await cleanup();throw reason;}
}

/** 기존 함수 이름도 동일한 HTTP 전송을 사용하며 브라우저를 실행하지 않습니다. */
export const openG2bDownload=openHttpDownload;

/** 기존 내부 접근 경로를 명시적 첨부 식별자로 해석한 뒤 공통 HTTP 전송을 사용합니다. */
export async function handleAttachmentRequest(request:Request,key:string,
 dependencies:DownloadDependencies={load:getNoticeRecord,open:openHttpDownload}):Promise<Response>{
 const requestUrl=new URL(request.url);
 const identity=parseAttachmentDownloadUrl(`${requestUrl.pathname}${requestUrl.search}`);
 if(!identity||identity.key!==key)return new Response('첨부파일 식별자가 올바르지 않습니다.',{status:400});
 const notice=await dependencies.load(key);
 const sources=identity.modalIndex===undefined?notice?.detail?.attachments.filter(a=>a.fileNo===identity.fileNo&&a.seq===identity.seq):
  notice?.detail?.modalAttachmentSources?.filter(a=>a.fileNo===identity.fileNo&&a.seq===identity.seq&&a.modalIndex===identity.modalIndex);
 if(sources?.length!==1||!sources[0].url||!validateDirectAttachmentUrl(sources[0].url))return new Response('첨부파일을 찾을 수 없습니다.',{status:404});
 let opened:OpenedDownload;
 try{opened=await dependencies.open(sources[0].url,request.signal);}
 catch(error){const maintenance=maintenanceFromError(error);if(maintenance)return Response.json({error:maintenance.message,maintenance},{status:503});return new Response('나라장터 파일 다운로드에 실패했습니다.',{status:502});}
 const {stream}=opened;let closed=false;
 /** 응답 소비 종료와 요청 취소가 겹쳐도 파일 자원을 한 번만 정리합니다. */
 const close=()=>{if(closed)return;closed=true;request.signal.removeEventListener('abort',abort);void opened.cleanup().catch(()=>undefined);};
 const abort=()=>{stream.destroy();close();};
 stream.once('end',close);stream.once('close',close);stream.once('error',close);
 request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
 return new Response(Readable.toWeb(stream) as ReadableStream,{status:200,headers:{
  'Content-Type':opened.contentType||'application/octet-stream',
  'Content-Disposition':`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(opened.filename)}`,
  'Cache-Control':'no-store',
 }});
}
