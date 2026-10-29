import { expect, it, vi } from "vitest";
import { classifyExtractionError } from "./errors";
import { runBatch, LocalWake } from "./worker";

it("영구 오류와 일시 오류를 구분하고 내부 메시지는 저장하지 않습니다",()=>{
  expect(classifyExtractionError(new Error("PDF 처리 시간이 5분 제한을 초과했습니다.")).retry).toBe(false);
  expect(classifyExtractionError(new Error("PDF가 손상되었거나 읽을 수 없는 형식입니다.")).code).toBe("invalid_pdf");
  expect(classifyExtractionError(new Error("net::ERR_CONNECTION_RESET secret")).message).not.toContain("secret");
  expect(classifyExtractionError(new Error("net::ERR_CONNECTION_RESET")).retry).toBe(true);
});

/** 실제 실행 대신 제어 가능한 저장소로 배치 경계만 검사합니다. */
function batchStore(){
 return {acquire:vi.fn(async()=>true),release:vi.fn(async()=>{}),renew:vi.fn(async()=>true),
 recover:vi.fn(async()=>({checked:0,recovered:0,exhausted:0})),
 claim:vi.fn(async()=>({id:"id",notice_key:"key"})),complete:vi.fn(async()=>{}),fail:vi.fn(async()=>{}),readyCount:vi.fn(async()=>0)};
}
it("임대 갱신 실패는 자식을 중단하고 결과 저장·다음 파일 선점을 막습니다",async()=>{
 const store=batchStore();store.renew.mockResolvedValue(false);
 const summary=await runBatch(store as never,{mode:"local",heartbeatMs:5,extract:async(_r,_t,signal)=>{
   await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
   throw new Error('중단');
 }});
 expect(summary.reason).toBe('lease_lost');expect(store.claim).toHaveBeenCalledTimes(1);
 expect(store.fail).not.toHaveBeenCalled();expect(store.complete).not.toHaveBeenCalled();expect(store.release).toHaveBeenCalledOnce();
});
it("저장 실패를 추출 실패로 바꾸지 않고 복구 대상 processing을 남깁니다",async()=>{
 const store=batchStore();store.complete.mockRejectedValue(new Error('DB 저장 오류'));
 await expect(runBatch(store as never,{mode:"local",extract:async()=>({result:{pages:[],pageCount:0,characterCount:0,extractorVersion:"test",fileHash:"hash"},peakMemory:null})})).rejects.toThrow('DB 저장');
 expect(store.fail).not.toHaveBeenCalled();expect(store.release).toHaveBeenCalledOnce();
});
it("6분 여유가 없으면 파일을 시작하지 않고 미래 요청만 남아도 기다리지 않습니다",async()=>{
 const store=batchStore();let calls=0;
 expect((await runBatch(store as never,{mode:"local",now:()=>calls++?15*60000:0})).reason).toBe('time_budget');
 expect(store.claim).not.toHaveBeenCalled();
 store.claim.mockResolvedValue(null as never);
 expect((await runBatch(store as never,{mode:"local"})).reason).toBe('no_ready_request');
});
it("갱신 응답이 영원히 없으면 제한 시간 안에 자식을 중단하고 회차를 종료합니다",async()=>{
 const store=batchStore();store.renew.mockImplementation(()=>new Promise(()=>{}));
 const summary=await runBatch(store as never,{mode:'local',heartbeatMs:5,renewalTimeoutMs:15,extract:async(_r,_t,signal)=>{
   await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));throw new Error('중단');
 }});
 expect(summary.reason).toBe('lease_lost');expect(store.release).toHaveBeenCalledOnce();
},500);
it("발견 전에 복구하고 복구로 실행 여유가 줄면 선점하지 않습니다",async()=>{
 const store=batchStore(),order:string[]=[];let time=0;
 store.recover.mockImplementation(async()=>{order.push('recover');time=15*60000;return {checked:0,recovered:0,exhausted:0};});
 const discovery={...store,discover:async()=>{order.push('discover');return 0;}};
 await runBatch(discovery as never,{mode:'cloud',discover:true,budgetMinutes:20,now:()=>time});
 expect(order[0]).toBe('recover');expect(store.claim).not.toHaveBeenCalled();
});
it("선점 대기로 6분 여유가 사라지면 추출 없이 대기로 반환합니다",async()=>{
 const store=batchStore();let time=0;
 store.claim.mockImplementation(async()=>{time=15*60000;return {id:'id',notice_key:'key'};});
 const deferClaim=vi.fn(async()=>{}),extract=vi.fn();
 const summary=await runBatch({...store,deferClaim} as never,{mode:'local',now:()=>time,extract});
 expect(summary.reason).toBe('time_budget');expect(extract).not.toHaveBeenCalled();expect(deferClaim).toHaveBeenCalledOnce();
});
it("로컬 깨우기를 합치며 실행 중 추가 깨우기로 새 회차를 예약하지 않습니다",async()=>{
 let resolve!:()=>void, calls=0;
 const wake=new LocalWake(async()=>{calls++;await new Promise<void>(r=>{resolve=r;});});
 const first=wake.wake(); wake.wake(); expect(calls).toBe(1); resolve(); await first;
 const second=wake.wake();expect(calls).toBe(2);resolve();await second;
});
it("로컬 회차는 manual만 최대 3건 처리하고 실행 예산을 초기화하지 않습니다",async()=>{
 const claims: unknown[]=[];let processed=0;
 const store={acquire:async()=>true,release:async()=>{},renew:async()=>true,recover:async()=>({recovered:0,checked:0,exhausted:0}),
 claim:async(_token:string,manual:boolean)=>{claims.push(manual);return {id:String(claims.length),notice_key:"key"};},
 complete:async()=>{processed++;},fail:async()=>{},readyCount:async()=>8};
 const summary=await runBatch(store as never,{mode:"local",extract:async()=>({result:{pages:[],pageCount:0,characterCount:0,extractorVersion:"test",fileHash:"hash"},peakMemory:null})});
 expect(processed).toBe(3);expect(claims).toEqual([true,true,true]);expect(summary.reason).toBe("count_limit");
});
