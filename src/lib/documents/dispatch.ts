import type { PdfDispatchState } from "./dispatch-state";
import { normalizeDispatchRepository } from "./dispatch-state";

export type DispatchResponse = { accepted: boolean; reason: "accepted"|"invalid_configuration"|"timeout"|"cancelled"|"network_error"|"http_error";
  httpStatus?: number; runUrl?: string };
type Options = { repository: string; token: string; fetcher?: typeof fetch; signal?: AbortSignal };
export type DispatchTick = { reason: string; attempted: boolean; generation?: string; httpStatus?: number; runUrl?: string };

/** 고정된 워크플로만 15초 안에 호출하고 인증 정보나 외부 오류 본문은 반환하지 않습니다. */
export async function dispatchPdfWorkflow(options: Options): Promise<DispatchResponse> {
  const {repository,token} = options;
  if (normalizeDispatchRepository(repository) !== repository || !token || /[\r\n]/.test(token)) return {accepted:false,reason:"invalid_configuration"};
  if (options.signal?.aborted) return {accepted:false,reason:"cancelled"};
  const controller = new AbortController();
  let cancel!:(reason:Error)=>void;
  const cancelled=new Promise<never>((_resolve,reject)=>{cancel=reject;});
  const abort = () => {controller.abort();cancel(new Error("PDF dispatch cancelled"));};
  options.signal?.addEventListener("abort",abort,{once:true});
  let timedOut = false, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = async (): Promise<DispatchResponse> => {
      const response = await (options.fetcher ?? fetch)(`https://api.github.com/repos/${repository}/actions/workflows/pdf-extract.yml/dispatches`, {
        method:"POST",redirect:"error",signal:controller.signal,
        headers:{Authorization:`Bearer ${token}`,Accept:"application/vnd.github+json","Content-Type":"application/json","X-GitHub-Api-Version":"2026-03-10"},
        body:JSON.stringify({ref:"main",inputs:{mode:"queue-only",invocation:"collection-progress",limit:"50",notice_key:""}}),
      });
      if (response.status!==200 && response.status!==204) {
        await response.body?.cancel().catch(()=>undefined);
        return {accepted:false,reason:"http_error",httpStatus:response.status};
      }
      let runUrl: string | undefined;
      if (response.status===200) {
        const body = await response.json().catch(()=>null) as {html_url?:unknown}|null;
        const prefix = `https://github.com/${repository}/actions/runs/`;
        if (typeof body?.html_url==="string" && body.html_url.startsWith(prefix) && /^\d+$/.test(body.html_url.slice(prefix.length))) runUrl=body.html_url;
      }
      return {accepted:true,reason:"accepted",httpStatus:response.status,...(runUrl?{runUrl}:{})};
    };
    return await Promise.race([request(),cancelled,new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new Error("PDF dispatch timeout"));},15_000);
    })]);
  } catch {
    return {accepted:false,reason:timedOut?"timeout":controller.signal.aborted?"cancelled":"network_error"};
  } finally { clearTimeout(timer);options.signal?.removeEventListener("abort",abort); }
}

/** DB 커밋 후에만 외부 호출을 수행하고 호출 실패를 수집 처리로 전파하지 않습니다. */
export async function runPdfDispatch(store: PdfDispatchState, options: Options): Promise<DispatchTick> {
  if (!options.token || /[\r\n]/.test(options.token) || normalizeDispatchRepository(options.repository)!==options.repository) return {reason:"invalid_configuration",attempted:false};
  if (options.signal?.aborted) return {reason:"cancelled",attempted:false};
  let attempted=false;
  try {
    const claim = await store.claim(options.repository);
    if (claim.reason!=="claimed") return {reason:claim.reason,attempted:false};
    attempted=true;
    const response=await dispatchPdfWorkflow(options);
    const owned=await store.finish(options.repository,claim.token,claim.generation,response);
    return {reason:owned?response.reason:"lease_lost",attempted:true,generation:claim.generation,
      ...(response.httpStatus?{httpStatus:response.httpStatus}:{}),...(response.runUrl?{runUrl:response.runUrl}:{})};
  } catch { return {reason:"db_error",attempted}; }
}
