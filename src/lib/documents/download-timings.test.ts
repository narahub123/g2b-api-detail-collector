import {expect,it} from 'vitest';
import {createDownloadMeasure} from './download-timings';
import {isExtractionProgress,type ExtractionProgress} from './diagnostics';
import {advanceStageTimings} from './stage-timings';

it('단조 시계로 누적 스냅샷을 만들고 실패한 구간도 보존합니다',async()=>{
 const events:ExtractionProgress[]=[];let clock=0;
 const measure=createDownloadMeasure(value=>events.push(value),()=>clock);
 await measure('browser',async()=>{clock=25;});
 await expect(measure('navigation',async()=>{clock=75;throw new Error('접속 실패');})).rejects.toThrow('접속 실패');
 const last=events.at(-1)!;
 expect(last.details).toMatchObject([{step:'browser',elapsedMs:25,outcome:'completed'},{step:'navigation',elapsedMs:50,outcome:'failed'}]);
 expect(events[0].details?.[0].outcome).toBe('running');
 const first=advanceStageTimings([],events[0]);
 const updated=advanceStageTimings(first,last);
 expect(updated).toHaveLength(1);expect(updated[0].details).toEqual(last.details);
 expect(first[0].details?.[0].outcome).toBe('running');
 expect(isExtractionProgress(last)).toBe(true);
 expect(isExtractionProgress({...last,details:[{step:'unknown',elapsedMs:-1,outcome:'completed'}]})).toBe(false);
});

it('무시하고 진행하는 대기 실패는 별도 상태로 남깁니다',async()=>{
 const events:ExtractionProgress[]=[];
 const measure=createDownloadMeasure(value=>events.push(value));
 await expect(measure('networkIdle',async()=>{throw new Error('대기 실패');},'skipped')).rejects.toThrow();
 expect(events.at(-1)?.details?.[0].outcome).toBe('skipped');
});
