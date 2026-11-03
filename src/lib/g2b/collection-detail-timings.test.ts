import {expect, it} from 'vitest';
import {measure, measureSync} from './collection-performance';
import {withCollectionDetailTiming} from './collection-detail-measure';
import {createCollectionTimings, interruptCollectionTimings} from './collection-timings';
import type {CollectionJob} from './collection-job';
import type {CollectionDetailEvent} from './collection-detail-steps';

/** 외부 연결 없이 공고와 작업의 계측 결과를 확인합니다. */
function fixture() {
  const result = {key:'A--000', status:'pending' as const};
  const job:CollectionJob = {id:'test',status:'running',phase:'detail',range:null,apiCount:0,
    detailSucceeded:0,detailFailed:0,errors:[],startedAt:new Date(0).toISOString(),results:[result]};
  return {job,result:job.results![0]};
}

it('구간 시작과 종료를 복사해 전달하고 시간 초과와 계속 진행을 구분합니다',async()=>{
  let time=0;
  const events:CollectionDetailEvent[]=[];
  await withCollectionDetailTiming(event=>events.push(event),async()=>{
    const details={outcome:'pending',candidateId:'button-1',depth:2};
    await measure('modal.wait-settled',async()=>{time=25;details.outcome='timeout';},details);
    await measure('wait.network-idle',async()=>{time=40;throw Error('timeout');}).catch(()=>undefined);
    measureSync('modal.extract',()=>{time=45;return 7;});
  },()=>time);
  expect(events.map(event=>[event.phase,event.outcome,event.elapsedMs])).toEqual([
    ['start','running',0],['end','timeout',25],['start','running',0],['end','continued',15],
    ['start','running',0],['end','completed',5],
  ]);
  expect(events[0].context).toEqual({candidateId:'button-1',depth:2});
});

it('반복 구간은 누적·최대·결과별 횟수로 집계하고 실행 중 시간은 중복하지 않습니다',async()=>{
  const {job,result}=fixture();let time=0;
  const clock=createCollectionTimings(job,()=>time);
  clock.transition('modals',new Date(0).toISOString(),result);
  await withCollectionDetailTiming(event=>clock.detail(event,result),async()=>{
    await measure('modal.open',async()=>{time=10;clock.checkpoint(new Date(10).toISOString());});
    await measure('modal.open',async()=>{time=40;clock.checkpoint(new Date(40).toISOString());});
    await measure('modal.open',async()=>{time=45;throw Error('click');}).catch(()=>undefined);
  },()=>time);
  const stat=result.timings!.details!.modals!.steps['modal.open'];
  expect(stat).toEqual({elapsedMs:45,count:3,maxMs:30,outcomes:{completed:2,failed:1}});
  expect(job.timings!.details).toEqual(result.timings!.details);
  expect(result.timings!.details!.modals!.active).toEqual([]);
  clock.finishNotice(result,'failed',new Date(45).toISOString());
  clock.transition('opening',new Date(50).toISOString(),result);
  expect(result.timings!.details!.modals!.steps['modal.open']).toEqual(stat);
});

it('중단 복구는 마지막 저장 관측값만 확정하고 지연 종료를 중복 집계하지 않습니다',()=>{
  const {job,result}=fixture();let time=0;
  const clock=createCollectionTimings(job,()=>time);
  clock.transition('opening',new Date(0).toISOString(),result);
  const event:CollectionDetailEvent={id:'span',step:'page.goto',stage:'opening',phase:'start',outcome:'running',elapsedMs:0,at:new Date(0).toISOString()};
  clock.detail(event,result);time=15;clock.checkpoint(new Date(15).toISOString());
  job.status='interrupted';
  expect(interruptCollectionTimings(job)).toBe(true);
  expect(result.timings!.details!.opening!.steps['page.goto']).toEqual({elapsedMs:15,count:1,maxMs:15,outcomes:{interrupted:1}});
  clock.detail({...event,phase:'end',outcome:'completed',elapsedMs:1000},result);
  expect(result.timings!.details!.opening!.steps['page.goto']!.count).toBe(1);
});

it('관측 콜백 실패와 비활성 계측이 원래 반환값과 예외를 보존합니다',async()=>{
  const error=Error('original');
  expect(await withCollectionDetailTiming(()=>{throw Error('observer');},()=>measure('page.goto',async()=>42))).toBe(42);
  await expect(withCollectionDetailTiming(()=>{throw Error('observer');},()=>measure('page.goto',async()=>{throw error;}))).rejects.toBe(error);
  expect(await measure('page.goto',async()=>9)).toBe(9);
});
