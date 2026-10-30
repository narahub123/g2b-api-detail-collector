import {expect,it} from 'vitest';
import {measure,measureSync,withMeasurement,type TimingEvent} from './collection-performance';
import {prepareTargets,runSample,validateManifest} from './collection-benchmark';

it('비활성 측정과 기록 실패가 원래 결과와 오류를 보존합니다',async()=>{
 expect(await measure('off',async()=>42)).toBe(42);
 const error=new Error('원래 오류');
 await expect(withMeasurement({runId:'r',key:'A--000',attempt:1,sink:()=>{throw Error('출력 실패');}},()=>measure('failed',async()=>{throw error;}))).rejects.toBe(error);
});
it('원래 오류를 유지하며 실패한 작업의 시간과 상태를 남깁니다',async()=>{
 const events:TimingEvent[]=[];const error=Error('실패');
 await expect(withMeasurement({runId:'r',key:'A--000',attempt:1,sink:e=>events.push(e)},()=>measure('scrape',async()=>{throw error;}))).rejects.toBe(error);
 expect(events).toHaveLength(1);expect(events[0]).toMatchObject({status:'failed',operation:'scrape',key:'A--000'});
 expect(events[0].durationMs).toBeGreaterThanOrEqual(0);expect(JSON.stringify(events)).not.toContain('실패');
});
it('후보 정보와 실제 대기 결과를 함수 성공 여부와 구분해 기록합니다',async()=>{
 const events:TimingEvent[]=[];const details={candidateId:'button-1',outcome:'pending'};
 const result=await withMeasurement({runId:'r',key:'A--000',attempt:1,sink:e=>events.push(e)},()=>measure('modal.wait-settled',async()=>{details.outcome='timeout';return 7;},details));
 expect(result).toBe(7);expect(events[0]).toMatchObject({status:'succeeded',details:{candidateId:'button-1',outcome:'timeout'}});
});
it('동시 공고의 문맥과 중첩 부모를 구분하고 동기 측정도 기록합니다',async()=>{
 const events:TimingEvent[]=[];
 await Promise.all(['A','B'].map(key=>withMeasurement({runId:'r',key,attempt:1,sink:e=>events.push(e)},()=>measure('notice',async()=>{
  await Promise.resolve();measureSync('transform',()=>key);
 }))));
 for(const key of ['A','B']){const rows=events.filter(e=>e.key===key);expect(rows).toHaveLength(2);expect(rows[0].parentSpanId).toBe(rows[1].spanId);expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);}
});
it('원래 API 페이지를 변형하지 않고 중복 제외 3건에서 조회를 중단합니다',async()=>{
 let closed=false;let extra=false;
 async function* pages(){try{yield {items:[{bidNtceNo:'A',bidNtceOrd:'000'},{bidNtceNo:'A',bidNtceOrd:'000'},{bidNtceNo:'B',bidNtceOrd:'000'},{bidNtceNo:'C',bidNtceOrd:'000'}]};extra=true;yield {items:[]};}finally{closed=true;}}
 expect(await prepareTargets(pages())).toEqual(['A--000','B--000','C--000']);expect(closed).toBe(true);expect(extra).toBe(false);
});
it('대상 부족과 잘못된 manifest를 거부합니다',async()=>{
 await expect(prepareTargets((async function*(){yield {items:[]};})())).rejects.toThrow();
 expect(()=>validateManifest({version:1,keys:['A--000','A--000','C--000']})).toThrow();
});
it('실패를 재시도하지 않고 선정 공고만 순서대로 실행합니다',async()=>{
 const called:string[]=[];const rows=await runSample(['A--000','B--000','C--000'],async key=>{called.push(key);if(key==='B--000')throw Error('실패');return {relatedNoticeKeys:['D--000']};});
 expect(called).toEqual(['A--000','B--000','C--000']);expect(rows.map(r=>r.status)).toEqual(['succeeded','failed','succeeded']);
});
