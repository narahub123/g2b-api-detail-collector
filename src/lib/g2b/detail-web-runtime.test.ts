import { afterEach, expect, it, vi } from "vitest";
import process from "node:process";

const mocks = vi.hoisted(() => ({
  dispatcher: {start:vi.fn(),wake:vi.fn(),finish:vi.fn().mockResolvedValue(undefined)},
  create:vi.fn(), consume:vi.fn(), pool:{},
}));
vi.mock("../documents/dispatch-runtime", () => ({createWebPdfDispatcher:mocks.create}));
vi.mock("./postgres-store", () => ({getPool:()=>mocks.pool}));
vi.mock("./detail-queue", () => ({DetailQueue:class {}}));
vi.mock("./collection-queue-worker", () => ({consumeCollectionQueue:mocks.consume}));

const state=process as typeof process & {
  __g2bDetailRuntime?:import("./detail-runtime").DetailRuntime; __g2bDetailToken?:string;
  __g2bDetailWork?:Promise<number>; __g2bPdfDispatcher?:unknown;
};
afterEach(async()=>{
  await state.__g2bDetailRuntime?.stop();
  delete state.__g2bDetailRuntime;delete state.__g2bDetailToken;
  delete state.__g2bDetailWork;delete state.__g2bPdfDispatcher;
  vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.useRealTimers();vi.resetModules();
});

it("웹 재로딩은 조정기를 재생성하지 않고 커밋 후 완료 신호를 전달하며 종료를 정리합니다",async()=>{
  vi.stubEnv("DETAIL_COLLECTION_QUEUE_ENABLED","true");vi.stubEnv("DATABASE_URL","test");
  vi.stubEnv("G2B_DB_SCHEMA","web_test");
  vi.spyOn(process,"once").mockReturnValue(process);
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({ok:true})));
  mocks.create.mockReturnValue(mocks.dispatcher);
  mocks.consume.mockImplementation(async(_queue,options)=>{options.onDetailFinished();return 1;});
  const web=await import("./detail-web-runtime");
  const runtime=web.startDetailWebRuntime()!;
  await runtime.pending;
  vi.resetModules();
  expect((await import("./detail-web-runtime")).startDetailWebRuntime()).toBe(runtime);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.create).toHaveBeenCalledWith(mocks.pool,"web_test",runtime.signal);
  expect(mocks.dispatcher.start).toHaveBeenCalledTimes(1);
  const after: Array<()=>Promise<void>>=[];
  expect(web.scheduleDetailWebRequest("Bearer wrong",work=>after.push(work))).toBe(false);
  expect(web.scheduleDetailWebRequest(`Bearer ${state.__g2bDetailToken}`,work=>after.push(work))).toBe(true);
  await after[0]();expect(mocks.dispatcher.wake).toHaveBeenCalledTimes(1);
  const stop=vi.mocked(process.once).mock.calls.find(([event])=>event==="SIGTERM")![1];
  stop();await vi.waitFor(()=>expect(mocks.dispatcher.finish).toHaveBeenCalledTimes(1));
  expect(runtime.signal.aborted).toBe(true);
});
