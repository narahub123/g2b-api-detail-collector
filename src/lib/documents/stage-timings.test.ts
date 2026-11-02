import { expect, it } from 'vitest';
import { advanceStageTimings, finishStageTimings } from './stage-timings';

it('같은 단계의 진행은 시작을 유지하고 전환 시 이전 구간을 마감합니다', () => {
 const first=advanceStageTimings([], {stage:'download',at:'2026-11-02T00:00:00Z'});
 const repeat=advanceStageTimings(first, {stage:'download',at:'2026-11-02T00:00:01Z'});
 expect(repeat).toEqual(first);
 const next=advanceStageTimings(repeat,{stage:'opening',at:'2026-11-02T00:00:03Z'});
 expect(next[0]).toMatchObject({elapsedMs:3000,outcome:'transition',endedAt:'2026-11-02T00:00:03.000Z',estimated:false});
 expect(next[1]).toMatchObject({stage:'opening',endedAt:null,elapsedMs:null,outcome:'running'});
 expect(first[0].endedAt).toBeNull();
});

it('보류 후 재개 구간은 누적하되 대기 시간을 포함하지 않습니다', () => {
 const first=advanceStageTimings([],{stage:'download',at:'2026-11-02T00:00:00Z'});
 const deferred=finishStageTimings(first,'2026-11-02T00:00:02Z','deferred');
 const resumed=advanceStageTimings(deferred,{stage:'download',at:'2026-11-02T01:00:00Z'});
 const result=finishStageTimings(resumed,'2026-11-02T01:00:04Z','completed');
 expect(result.map(segment=>segment.elapsedMs)).toEqual([2000,4000]);
});

it('실패·강제 종료를 구분하고 누락되거나 역전된 시각에서 잘못된 시간을 만들지 않습니다', () => {
 const first=advanceStageTimings([],{stage:'extracting',at:'2026-11-02T00:00:03Z'});
 expect(finishStageTimings(first,'2026-11-02T00:00:05Z','failed')[0]).toMatchObject({elapsedMs:2000,outcome:'failed',estimated:false});
 expect(finishStageTimings(first,'2026-11-02T00:00:04Z','interrupted',true)[0]).toMatchObject({elapsedMs:1000,outcome:'interrupted',estimated:true});
 expect(advanceStageTimings(first,{stage:'opening',at:'2026-11-02T00:00:02Z'})).toEqual(first);
 expect(finishStageTimings([], '2026-11-02T00:00:05Z','completed')).toEqual([]);
});
