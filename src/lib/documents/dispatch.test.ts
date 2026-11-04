import { afterEach, expect, it, vi } from "vitest";
import { dispatchPdfWorkflow, runPdfDispatch } from "./dispatch";
import type { PdfDispatchState } from "./dispatch-state";
import { actionsDispatchAllowed, PdfDispatchRuntime } from "./dispatch-runtime";

const repository = "narahub123/g2b-api-detail-collector";
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it.each([200,204])("공통 PDF 워크플로에 고정된 자동 입력만 전송하고 %i 응답을 수락합니다", async status => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(status===200 ? Response.json({workflow_run_id:123,
    html_url:`https://github.com/${repository}/actions/runs/123`}) : new Response(null,{status:204}));
  const result = await dispatchPdfWorkflow({repository,token:"test-secret",fetcher});
  expect(result).toMatchObject({accepted:true,httpStatus:status});
  const [url,init] = fetcher.mock.calls[0];
  expect(url).toBe(`https://api.github.com/repos/${repository}/actions/workflows/pdf-extract.yml/dispatches`);
  expect(init?.redirect).toBe("error"); expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ref:"main",inputs:{mode:"queue-only",invocation:"collection-progress",limit:"50",notice_key:""}});
  expect(JSON.stringify(result)).not.toContain("test-secret");
});

it("임의 저장소 경로·인증 헤더와 외부 실행 링크를 허용하지 않습니다", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({html_url:"https://evil.example/run"}));
  expect((await dispatchPdfWorkflow({repository:"../repo",token:"secret",fetcher})).accepted).toBe(false);
  expect((await dispatchPdfWorkflow({repository,token:"secret\r\nother: value",fetcher})).accepted).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await dispatchPdfWorkflow({repository,token:"secret",fetcher})).runUrl).toBeUndefined();
});

it("호출이 응답하지 않아도 15초에 중단하며 원래 오류를 반환하지 않습니다", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(()=>new Promise(()=>undefined));
  const pending = dispatchPdfWorkflow({repository,token:"secret",fetcher});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toMatchObject({accepted:false,reason:"timeout"});
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it("수집 종료 신호는 응답 없는 외부 호출도 즉시 취소합니다",async()=>{
  const controller=new AbortController();
  const fetcher=vi.fn<typeof fetch>().mockImplementation(()=>new Promise(()=>undefined));
  const pending=dispatchPdfWorkflow({repository,token:"secret",fetcher,signal:controller.signal});
  controller.abort();expect(await pending).toMatchObject({accepted:false,reason:"cancelled"});
});

it("호출 실패를 수집 오류로 전파하지 않고 세대와 토큰으로 종료 상태를 기록합니다", async () => {
  const finish = vi.fn().mockResolvedValue(true);
  const store = {claim:vi.fn().mockResolvedValue({reason:"claimed",token:"owner",generation:"7"}),finish};
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("token=secret db=private"));
  const result = await runPdfDispatch(store as unknown as PdfDispatchState,{repository,token:"secret",fetcher});
  expect(result).toMatchObject({reason:"network_error",attempted:true,generation:"7"});
  expect(finish).toHaveBeenCalledWith(repository,"owner","7",expect.objectContaining({accepted:false}));
  expect(JSON.stringify(result)).not.toMatch(/secret|private/);
});

it("호출 중인 조정기는 다시 호출하지 않고 종료 시 미처리 확인을 합칩니다", async () => {
  vi.useFakeTimers();
  let release!:()=>void;
  const first = new Promise<void>(resolve=>{release=resolve;});
  const pulse = vi.fn().mockImplementationOnce(()=>first).mockResolvedValue(undefined);
  const runtime = new PdfDispatchRuntime(pulse);
  runtime.start();runtime.wake();runtime.wake();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(pulse).toHaveBeenCalledTimes(1);
  release();await runtime.finish();
  expect(pulse).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(300_000);expect(pulse).toHaveBeenCalledTimes(2);
});
it("호출 조정기 종료와 전용 연결 정리는 한 번만 수행합니다",async()=>{
  const pulse=vi.fn().mockResolvedValue(undefined),close=vi.fn().mockResolvedValue(undefined);
  const runtime=new PdfDispatchRuntime(pulse,undefined,close);runtime.start();
  await Promise.all([runtime.finish(),runtime.finish()]);expect(close).toHaveBeenCalledTimes(1);
});

it("Actions 수집의 main 실행에서만 활성화하고 웹·일반 CLI·다른 브랜치는 호출하지 않습니다", () => {
  const env = {PDF_PROGRESS_DISPATCH_ENABLED:"true",G2B_PDF_EXTRACTION_ENABLED:"true",DETAIL_PDF_REGISTRATION_ENABLED:"true",
    GITHUB_ACTIONS:"true",GITHUB_REF:"refs/heads/main",GITHUB_REPOSITORY:repository,
    GITHUB_WORKFLOW_REF:`${repository}/.github/workflows/collect.yml@refs/heads/main`};
  expect(actionsDispatchAllowed(env)).toBe(true);
  for (const override of [{GITHUB_ACTIONS:"false"},{GITHUB_REF:"refs/heads/feature"},{PDF_PROGRESS_DISPATCH_ENABLED:"false"},
    {G2B_PDF_EXTRACTION_ENABLED:"false"},{GITHUB_WORKFLOW_REF:`${repository}/.github/workflows/other.yml@refs/heads/main`}]) {
    expect(actionsDispatchAllowed({...env,...override})).toBe(false);
  }
});
