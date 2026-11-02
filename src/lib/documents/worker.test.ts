import { expect, it, vi } from "vitest";
import { classifyExtractionError } from "./errors";
import { runBatch, LocalWake } from "./worker";
import type {ExtractionProgress} from './diagnostics';

it("영구 오류와 일시 오류를 구분하고 내부 메시지는 저장하지 않습니다",()=>{
  expect(classifyExtractionError(new Error("PDF 처리 시간이 5분 제한을 초과했습니다.")).retry).toBe(false);
  expect(classifyExtractionError(new Error("PDF가 손상되었거나 읽을 수 없는 형식입니다.")).code).toBe("invalid_pdf");
  expect(classifyExtractionError(new Error("net::ERR_CONNECTION_RESET secret")).message).not.toContain("secret");
  expect(classifyExtractionError(new Error("net::ERR_CONNECTION_RESET")).retry).toBe(true);
});

/** 실제 실행 대신 제어 가능한 저장소로 배치 경계만 검사합니다. */
function batchStore(){
 return {acquire:vi.fn(async()=>true),release:vi.fn(async()=>{}),renew:vi.fn(async()=>true),
 recover:vi.fn(async()=>({checked:0,recovered:0,exhausted:0})),progress:vi.fn<(_token:string,_id:string,value:ExtractionProgress)=>Promise<void>>(async()=>{}),recordDiagnostic:vi.fn(async()=>{}),
 claim:vi.fn(async()=>({id:"id",notice_key:"key",source:'manual'})),complete:vi.fn(async()=>{}),fail:vi.fn(async()=>{}),readyCounts:vi.fn(async()=>({manual:0,initial:0,reextract:0}))};
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
 expect(store.recordDiagnostic).toHaveBeenCalledWith(expect.any(String),'id',expect.objectContaining({message:'DB 저장 오류'}));
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
 store.claim.mockImplementation(async()=>{time=15*60000;return {id:'id',notice_key:'key',source:'manual'};});
 const deferClaim=vi.fn(async()=>{}),extract=vi.fn();
 const summary=await runBatch({...store,deferClaim} as never,{mode:'local',now:()=>time,extract});
 expect(summary.reason).toBe('time_budget');expect(extract).not.toHaveBeenCalled();expect(deferClaim).toHaveBeenCalledOnce();
});
it('회차 요약에 재시도·텍스트 없음·관측 메모리·처리 시간을 집계합니다',async()=>{
 const store=batchStore();store.claim.mockResolvedValue({id:'id',notice_key:'key',attempt_number:2} as never);
 const result=await runBatch(store as never,{mode:'local',limit:1,extract:async()=>({result:{pages:[],pageCount:0,characterCount:0,extractorVersion:'test',fileHash:'hash'},peakMemory:12345})});
 expect(result).toMatchObject({retries:1,noText:1,completed:0,failed:0,peakMemoryBytes:12345});
 expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
});
it("로컬 깨우기를 합치며 실행 중 추가 깨우기로 새 회차를 예약하지 않습니다",async()=>{
 let resolve!:()=>void, calls=0;
 const wake=new LocalWake(async()=>{calls++;await new Promise<void>(r=>{resolve=r;});});
 const first=wake.wake(); wake.wake(); expect(calls).toBe(1); resolve(); await first;
 const second=wake.wake();expect(calls).toBe(2);resolve();await second;
});
it('단계 변경과 마지막 페이지를 완료 저장 전에 순서대로 반영합니다',async()=>{
 const store=batchStore(),order:string[]=[];
 store.progress.mockImplementation(async(_token:string,_id:string,p:{stage:string;completedPages?:number})=>{order.push(`${p.stage}:${p.completedPages??'-'}`);});
 store.complete.mockImplementation(async()=>{order.push('complete');});
 await runBatch(store as never,{mode:'local',limit:1,extract:async(_r,_t,_s,progress)=>{
  progress?.({stage:'download',at:new Date().toISOString()});
  progress?.({stage:'extracting',at:new Date().toISOString(),currentPage:1,completedPages:0,totalPages:2});
  progress?.({stage:'extracting',at:new Date().toISOString(),currentPage:2,completedPages:2,totalPages:2});
  return {result:{pages:[],pageCount:2,characterCount:0,extractorVersion:'test',fileHash:'hash'},peakMemory:null};
 }});
 expect(order).toEqual(['attachment:-','download:-','extracting:0','extracting:2','saving:-','complete']);
});
it('다운로드 마지막 세부 기록을 다음 단계가 덮어쓰지 않습니다',async()=>{
 const store=batchStore();
 const details=[{step:'receive' as const,elapsedMs:50,outcome:'completed' as const}];
 await runBatch(store as never,{mode:'local',limit:1,extract:async(_r,_t,_s,progress)=>{
  progress?.({stage:'download',at:new Date().toISOString()});
  for(let i=0;i<28;i++)progress?.({stage:'download',at:new Date().toISOString(),details});
  progress?.({stage:'opening',at:new Date().toISOString()});
  return {result:{pages:[],pageCount:0,characterCount:0,extractorVersion:'test',fileHash:'hash'},peakMemory:null};
 }});
 expect(store.progress.mock.calls.some(call=>call[2].details?.[0]?.elapsedMs===50)).toBe(true);
 expect(store.progress.mock.calls.filter(call=>call[2].stage==='download')).toHaveLength(2);
});
it('긴 수신이 끝나기 전에도 마지막 하위 구간을 저장합니다',async()=>{
 vi.useFakeTimers();
 try{
  const store=batchStore();
  await runBatch(store as never,{mode:'local',limit:1,extract:async(_r,_t,_s,progress)=>{
   progress?.({stage:'download',at:new Date().toISOString()});
   progress?.({stage:'download',at:new Date().toISOString(),details:[{step:'receive',elapsedMs:null,outcome:'running'}]});
   await vi.advanceTimersByTimeAsync(2100);
   expect(store.progress.mock.calls.some(call=>call[2].details?.[0]?.step==='receive')).toBe(true);
   return {result:{pages:[],pageCount:0,characterCount:0,extractorVersion:'test',fileHash:'hash'},peakMemory:null};
  }});
 }finally{vi.useRealTimers();}
});
it.each(['shutdown','time_limit'] as const)('다운로드 %s 중단 시 대기 중인 마지막 details를 종료 전에 저장합니다',async(reason)=>{
 vi.useFakeTimers();
 try{
  const store=batchStore(),controller=new AbortController(),order:string[]=[];
  const details:NonNullable<ExtractionProgress['details']>=[
   {step:'start',elapsedMs:25,outcome:'completed'},
   {step:'receive',elapsedMs:75,outcome:'failed'},
  ];
  store.progress.mockImplementation(async(_token,_id,value)=>{if(value.details)order.push('details');});
  store.fail.mockImplementation(async()=>{order.push('fail');});
  store.release.mockImplementation(async()=>{order.push('release');});
  const summary=await runBatch(store as never,{mode:'local',limit:1,signal:controller.signal,extract:async(_r,_t,signal,progress)=>{
   progress?.({stage:'download',at:new Date().toISOString()});
   // 2초 저장 주기 전에 중단해 종료 시 flush가 빠지면 마지막 기록이 사라집니다.
   progress?.({stage:'download',at:new Date().toISOString(),details});
   expect(store.progress.mock.calls.some(call=>call[2].details)).toBe(false);
   if(reason==='shutdown'){controller.abort();expect(signal.aborted).toBe(true);}
   throw new Error('PDF 처리 시간이 5분 제한을 초과했습니다.');
  }});
  expect(store.progress).toHaveBeenCalledWith(expect.any(String),'id',expect.objectContaining({stage:'download',details}));
  expect(order).toEqual(reason==='shutdown'?['details','release']:['details','fail','release']);
  expect(summary.reason).toBe(reason==='shutdown'?'shutdown':'count_limit');
  expect(store.complete).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});
it('다운로드 중 임대를 잃으면 대기 중인 details를 이전 소유권으로 저장하지 않습니다',async()=>{
 vi.useFakeTimers();
 try{
  const store=batchStore();store.renew.mockResolvedValue(false);
  const summary=await runBatch(store as never,{mode:'local',heartbeatMs:5,extract:async(_r,_t,signal,progress)=>{
   progress?.({stage:'download',at:new Date().toISOString()});
   progress?.({stage:'download',at:new Date().toISOString(),details:[{step:'receive',elapsedMs:null,outcome:'running'}]});
   await vi.advanceTimersByTimeAsync(5);
   expect(signal.aborted).toBe(true);
   throw new Error('임대 상실로 중단');
  }});
  expect(summary.reason).toBe('lease_lost');
  expect(store.progress.mock.calls.some(call=>call[2].details)).toBe(false);
  expect(store.complete).not.toHaveBeenCalled();expect(store.fail).not.toHaveBeenCalled();
  expect(store.release).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
});
it('결과 저장 단계의 진행 기록 실패도 저장 진단으로 남깁니다',async()=>{
 const store=batchStore();store.progress.mockImplementation(async(_t:string,_id:string,p:{stage:string})=>{if(p.stage==='saving')throw new Error('진행 저장 실패');});
 await expect(runBatch(store as never,{mode:'local',limit:1,extract:async()=>({result:{pages:[],pageCount:0,characterCount:0,extractorVersion:'test',fileHash:'hash'},peakMemory:null})})).rejects.toThrow('진행 저장 실패');
 expect(store.recordDiagnostic).toHaveBeenCalled();expect(store.fail).not.toHaveBeenCalled();
});
it('추출 중 진행 기록 실패도 원본 오류를 정제해 진단으로 남깁니다',async()=>{
 const store=batchStore();store.progress.mockRejectedValue(new Error('진행 DB 오류 token=secret'));
 await expect(runBatch(store as never,{mode:'local',limit:1,extract:async()=>({result:{pages:[],pageCount:0,characterCount:0,extractorVersion:'test',fileHash:'hash'},peakMemory:null})})).rejects.toThrow('진행 DB 오류');
 expect(store.recordDiagnostic).toHaveBeenCalledOnce();expect(JSON.stringify(store.recordDiagnostic.mock.calls)).not.toContain('secret');expect(store.fail).not.toHaveBeenCalled();
});
it("로컬 회차는 manual만 최대 3건 처리하고 실행 예산을 초기화하지 않습니다",async()=>{
 const claims: unknown[]=[];let processed=0;
 const store={acquire:async()=>true,release:async()=>{},renew:async()=>true,recover:async()=>({recovered:0,checked:0,exhausted:0}),
 claim:async(_token:string,manual:boolean)=>{claims.push(manual);return {id:String(claims.length),notice_key:"key"};},
 complete:async()=>{processed++;},fail:async()=>{},readyCounts:async()=>({manual:8,initial:0,reextract:0})};
 const summary=await runBatch(store as never,{mode:"local",extract:async()=>({result:{pages:[],pageCount:0,characterCount:0,extractorVersion:"test",fileHash:"hash"},peakMemory:null})});
 expect(processed).toBe(3);expect(claims).toEqual([true,true,true]);expect(summary.reason).toBe("count_limit");
});
import { G2bMaintenanceError } from "../g2b/maintenance";

it('수동 문서를 먼저 처리한 뒤 파일 사이마다 발견합니다',async()=>{
 const store=batchStore(),events:string[]=[];
 const waiting=[{id:'manual',notice_key:'key',source:'manual',attempt_number:1}];
 const claim=async(_token:string,manualOnly:boolean)=>{
  const index=waiting.findIndex(run=>!manualOnly||run.source==='manual');
  return index<0?null:waiting.splice(index,1)[0];
 };
 let discovered=0;
 const discover=async()=>{events.push('discover');waiting.push({id:`auto-${++discovered}`,notice_key:'key',source:'auto',attempt_number:1});return 1;};
 const summary=await runBatch({...store,claim,discover} as never,{mode:'cloud',discover:true,limit:3,extract:async(run)=>{
  events.push(run.id);
  return {result:{pages:[],pageCount:0,characterCount:1,extractorVersion:'test',fileHash:'hash'},peakMemory:null};
 }});
 expect(events).toEqual(['manual','discover','auto-1','discover','auto-2']);
 expect(summary.byKind.manual).toMatchObject({attempts:1,completed:1});
 expect(summary.byKind.initial).toMatchObject({attempts:2,completed:2});
});

it('종류별 완료·실패·텍스트 없음과 남은 대기를 집계합니다',async()=>{
 const store=batchStore();
 const runs=[{id:'manual',source:'manual'},{id:'initial',source:'auto',purpose:'initial'},{id:'reextract',source:'auto',purpose:'reextract'}];
 store.claim.mockImplementation(async()=>runs.shift() as never);
 store.readyCounts.mockResolvedValue({manual:2,initial:3,reextract:4});
 const summary=await runBatch(store as never,{mode:'cloud',limit:3,extract:async(run)=>{
  if(run.id==='initial')throw new Error('PDF가 손상되었거나 읽을 수 없는 형식입니다.');
  return {result:{pages:[],pageCount:0,characterCount:run.id==='manual'?1:0,extractorVersion:'test',fileHash:'hash'},peakMemory:null};
 }});
 expect(summary.remainingReady).toBe(9);
 expect(summary.byKind).toEqual({manual:{attempts:1,completed:1,failed:0,noText:0,remainingReady:2},initial:{attempts:1,completed:0,failed:1,noText:0,remainingReady:3},reextract:{attempts:1,completed:0,failed:0,noText:1,remainingReady:4}});
});

it.each(['local','cloud'] as const)('%s 대기열 전용 실행은 발견하지 않습니다',async(mode)=>{
 const store=batchStore(),discover=vi.fn(async()=>0);
 await runBatch({...store,discover} as never,{mode,discover:mode==='local',limit:1,extract:async()=>({result:{pages:[],pageCount:0,characterCount:0,extractorVersion:'test',fileHash:'hash'},peakMemory:null})});
 expect(discover).not.toHaveBeenCalled();
});

it('발견 중 실행 여유가 사라지면 자동 문서를 선점하지 않습니다',async()=>{
 const store=batchStore();let time=0;
 store.claim.mockResolvedValue(null as never);
 const discover=async()=>{time=15*60000;return 1;};
 const summary=await runBatch({...store,discover} as never,{mode:'cloud',discover:true,budgetMinutes:20,now:()=>time});
 expect(summary.reason).toBe('time_budget');expect(summary.attempts).toBe(0);
 expect(store.claim).toHaveBeenCalledExactlyOnceWith(expect.any(String),true,undefined);
});

it('재추출 중 추가된 수동 요청을 다음 파일로 실행합니다',async()=>{
 const store=batchStore(),processed:string[]=[];
 const waiting=[{id:'old',notice_key:'key',source:'auto',purpose:'reextract'}];
 const claim=async(_token:string,manualOnly:boolean)=>{
  const index=waiting.findIndex(run=>!manualOnly||run.source==='manual');
  return index<0?null:waiting.splice(index,1)[0];
 };
 const summary=await runBatch({...store,claim} as never,{mode:'cloud',limit:2,extract:async(run)=>{
  processed.push(run.id);
  if(run.id==='old')waiting.push({id:'new-manual',notice_key:'key',source:'manual',purpose:'initial'});
  return {result:{pages:[],pageCount:0,characterCount:1,extractorVersion:'test',fileHash:'hash'},peakMemory:null};
 }});
 expect(processed).toEqual(['old','new-manual']);
 expect(summary.byKind.reextract.completed).toBe(1);expect(summary.byKind.manual.completed).toBe(1);
});

it("점검 문서는 같은 시도로 대기에 반환하고 후속 선점과 실패 집계를 중단합니다", async () => {
 const store=batchStore(),deferClaim=vi.fn(async()=>{});
 store.claim.mockResolvedValue({id:'id',notice_key:'key',source:'manual',attempt_number:2} as never);
 const summary=await runBatch({...store,deferClaim} as never,{mode:'local',extract:async()=>{throw new G2bMaintenanceError('download');}});
 expect(summary).toMatchObject({reason:'g2b_maintenance',attempts:0,retries:0,failed:0,maintenance:{source:'download'}});
 expect(summary.byKind.manual.attempts).toBe(0);
 expect(deferClaim).toHaveBeenCalledWith(expect.any(String),'id',expect.objectContaining({code:'g2b_maintenance'}));
 expect(store.claim).toHaveBeenCalledOnce();expect(store.fail).not.toHaveBeenCalled();expect(store.release).toHaveBeenCalledOnce();
});
