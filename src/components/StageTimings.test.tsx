// @vitest-environment jsdom
import {act,cleanup,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {StageTimings} from './StageTimings';

afterEach(()=>{cleanup();vi.useRealTimers();});
it('누락된 이전 기록은 시간을 추정하지 않습니다',()=>{
 render(<StageTimings/>);expect(screen.getByText('단계별 처리 시간: 기록 없음')).toBeInTheDocument();
});
it('완료와 미완료 및 추정 시간을 구분합니다',()=>{
 render(<StageTimings timings={[
  {stage:'download',startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:02Z',elapsedMs:2000,outcome:'completed',estimated:false},
  {stage:'extracting',startedAt:'2026-01-01T00:00:02Z',endedAt:'2026-01-01T00:00:05Z',elapsedMs:3000,outcome:'interrupted',estimated:true},
 ]}/>);
 expect(screen.getByText(/완료 · 2.0초/)).toBeInTheDocument();
 expect(screen.getByText(/중단 · 미완료 · 추정 · 3.0초/)).toBeInTheDocument();
});
it('진행 중인 단계는 현재 시각으로 경과 시간을 갱신합니다',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
 render(<StageTimings timings={[{stage:'opening',startedAt:'2026-01-01T00:00:00Z',endedAt:null,elapsedMs:null,outcome:'running',estimated:false}]}/>);
 await act(()=>vi.advanceTimersByTimeAsync(1000));
 expect(screen.getByText(/진행 중 · 6.0초/)).toBeInTheDocument();
});
