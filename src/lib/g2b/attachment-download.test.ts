import {afterEach,expect,it,vi} from 'vitest';
import {Readable} from 'node:stream';
import {openHttpDownload,handleAttachmentRequest} from './attachment-download';
import {attachmentDownloadUrl} from './attachment-links';
import type {ExtractionProgress} from '../documents/diagnostics';
import {createDownloadMeasure} from '../documents/download-timings';

const key='R26BK01796488--000',fileNo='357b884e-1fd9-4613-bdaf-49be5a5d1ff2';
const url='https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do?bidPbancNo=R26BK01796488&bidPbancOrd=000&fileSeq=4&prcmBsneSeCd=03&fileType=';
const signal=()=>new AbortController().signal;
/** 파일 응답의 헤더와 본문을 실제 Response로 구성합니다. */
function response(body:BodyInit='%PDF-test',headers:HeadersInit={}){return new Response(body,{headers:{'content-type':'application/pdf','content-disposition':"attachment; filename*=UTF-8''%EA%B3%B5%EA%B3%A0.pdf",...headers}});}
/** 반환한 스트림을 실제 소비해 전달된 바이트를 확인합니다. */
async function bytes(opened:Awaited<ReturnType<typeof openHttpDownload>>){const chunks:Buffer[]=[];try{for await(const c of opened.stream)chunks.push(Buffer.from(c));return Buffer.concat(chunks);}finally{await opened.cleanup();}}
afterEach(()=>vi.useRealTimers());

it('브라우저 없이 파일을 받고 요청·수신 계측을 마감합니다',async()=>{
 const events:ExtractionProgress[]=[];
 const fetcher=vi.fn<typeof fetch>().mockResolvedValue(response());
 const opened=await openHttpDownload(url,signal(),createDownloadMeasure(e=>events.push(e)),fetcher);
 expect(opened.filename).toBe('공고.pdf');expect((await bytes(opened)).toString()).toBe('%PDF-test');
 expect(fetcher).toHaveBeenCalledWith(url,expect.objectContaining({redirect:'manual',signal:expect.any(AbortSignal)}));
 expect(events.at(-1)?.details).toEqual(expect.arrayContaining([expect.objectContaining({step:'request',outcome:'completed'}),expect.objectContaining({step:'receive',outcome:'completed'})]));
});
it('일반 첨부는 PDF가 아닌 바이트도 그대로 전달합니다',async()=>{
 const opened=await openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(response('HWP contents',{'content-type':'application/octet-stream'})));
 expect((await bytes(opened)).toString()).toBe('HWP contents');
});
it('외부 주소와 외부 리다이렉트는 요청하지 않습니다',async()=>{
 const fetcher=vi.fn<typeof fetch>();
 await expect(openHttpDownload('https://other.test/file',signal(),undefined,fetcher)).rejects.toMatchObject({code:'attachment_unavailable'});
 expect(fetcher).not.toHaveBeenCalled();
 fetcher.mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://other.test/file'}}));
 await expect(openHttpDownload(url,signal(),undefined,fetcher)).rejects.toMatchObject({code:'attachment_unavailable'});
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it('허용된 리다이렉트는 따르고 네 번째 이동은 거부합니다',async()=>{
 const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:url.replace('fileSeq=4','fileSeq=5')}})).mockResolvedValueOnce(response());
 expect((await bytes(await openHttpDownload(url,signal(),undefined,fetcher))).toString()).toBe('%PDF-test');
 const loop=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(null,{status:302,headers:{location:url}}));
 await expect(openHttpDownload(url,signal(),undefined,loop)).rejects.toMatchObject({code:'download_response'});expect(loop).toHaveBeenCalledTimes(4);
});
it.each([429,500,503])('HTTP %s 오류는 재시도 가능한 오류로 분류합니다',async(status)=>{
 await expect(openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(new Response('error',{status})))).rejects.toMatchObject({code:'download_http_retry'});
});
it('일반 HTTP 오류와 비파일 응답을 거부합니다',async()=>{
 await expect(openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(new Response('missing',{status:404})))).rejects.toMatchObject({code:'download_response'});
 await expect(openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(response('<html><title>로그인</title></html>')))).rejects.toMatchObject({code:'download_response'});
 await expect(openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":true}',{headers:{'content-type':'application/json'}})))).rejects.toMatchObject({code:'download_response'});
});
it('점검 HTML은 HTTP 오류 상태에서도 점검 보류로 전달합니다',async()=>{
 const html='<html><title>시스템 점검 안내</title><p>현재 웹서비스가 중단되고 있음을 알려드립니다.</p></html>';
 await expect(openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(new Response(html,{status:503,headers:{'content-type':'text/html'}})))).rejects.toMatchObject({maintenance:{source:'download'}});
});
it('나뉘어 도착하는 점검 안내도 본문을 합쳐 판별합니다',async()=>{
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('<html><title>시스템 점검 안내</title>'));c.enqueue(Buffer.from('<p>현재 웹서비스가 중단되고 있음을 알려드립니다.</p></html>'));c.close();}});
 await expect(openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(new Response(body,{headers:{'content-type':'text/html'}})))).rejects.toMatchObject({maintenance:{source:'download'}});
});
it('선언된 크기와 수신 중 누적 크기에 50MiB 제한을 적용합니다',async()=>{
 await expect(openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(response('small',{'content-length':String(50*1024*1024+1)})))).rejects.toMatchObject({code:'size_limit'});
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('%PDF-'));c.enqueue(Buffer.alloc(50*1024*1024));c.close();}});
 const opened=await openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(response(body)));
 await expect(bytes(opened)).rejects.toMatchObject({code:'size_limit'});
});
it('수신 도중 취소하면 소스를 취소하고 마지막 계측을 실패로 마감합니다',async()=>{
 const controller=new AbortController(),cancel=vi.fn(),events:ExtractionProgress[]=[];
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('%PDF-'));},cancel});
 const opened=await openHttpDownload(url,controller.signal,createDownloadMeasure(e=>events.push(e)),vi.fn<typeof fetch>().mockResolvedValue(response(body)));
 const reading=bytes(opened);controller.abort();
 await expect(reading).rejects.toMatchObject({code:'download_cancelled'});expect(cancel).toHaveBeenCalled();
 expect(events.at(-1)?.details?.at(-1)).toMatchObject({step:'receive',outcome:'failed'});
});
it('응답 대기와 본문 수신 모두 120초 제한을 적용합니다',async()=>{
 vi.useFakeTimers();
 const pending=vi.fn<typeof fetch>().mockImplementation((_u,options)=>new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(options.signal?.reason),{once:true})));
 const failure=expect(openHttpDownload(url,signal(),undefined,pending)).rejects.toMatchObject({code:'download_timeout'});
 await vi.advanceTimersByTimeAsync(120000);await failure;
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('%PDF-'));}});
 const opened=await openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(response(body)));
 const reading=expect(bytes(opened)).rejects.toMatchObject({code:'download_timeout'});
 await vi.advanceTimersByTimeAsync(120000);await reading;
});
it('소비가 시작되지 않아도 제한 시간에 본문과 타이머를 정리합니다',async()=>{
 vi.useFakeTimers();const cancel=vi.fn();
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('%PDF-'));},cancel});
 const opened=await openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockResolvedValue(response(body)));
 await vi.advanceTimersByTimeAsync(120000);
 expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 await expect(bytes(opened)).rejects.toMatchObject({code:'download_timeout'});
});
it('네트워크 연결 실패를 기존 재시도 분류에 전달합니다',async()=>{
 await expect(openHttpDownload(url,signal(),undefined,vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')))).rejects.toMatchObject({code:'connection_failed'});
});
it('기존 내부 경로도 명시적 파일 식별자로 저장된 직접 주소를 선택합니다',async()=>{
 const open=vi.fn(async()=>({filename:'공고.pdf',stream:Readable.from([Buffer.from('%PDF-test')]),cleanup:async()=>{}}));
 const request=new Request('https://app.test'+attachmentDownloadUrl(key,fileNo,4));
 const result=await handleAttachmentRequest(request,key,{load:async()=>({detail:{attachments:[{name:'공고.pdf',url,fileNo,seq:4}]}}),open});
 expect(result.status).toBe(200);expect(await result.text()).toBe('%PDF-test');expect(open).toHaveBeenCalledWith(url,request.signal);
});
it('모달 식별자를 검증하고 기존 미변환 주소를 다운로드하지 않습니다',async()=>{
 const open=vi.fn();
 const result=await handleAttachmentRequest(new Request('https://app.test'+attachmentDownloadUrl(key,fileNo,4,2)),key,{load:async()=>({detail:{attachments:[],modalAttachmentSources:[{url,fileNo,seq:4,modalIndex:2,path:[]}]}}),open:async()=>({filename:'공고.pdf',stream:Readable.from([Buffer.from('file')]),cleanup:async()=>{}})});
 expect(result.status).toBe(200);await result.text();
 const legacy=attachmentDownloadUrl(key,fileNo,4);
 const excluded=await handleAttachmentRequest(new Request('https://app.test'+legacy),key,{load:async()=>({detail:{attachments:[{name:'공고.pdf',url:legacy,fileNo,seq:4}]}}),open});
 expect(excluded.status).toBe(404);expect(open).not.toHaveBeenCalled();
});
