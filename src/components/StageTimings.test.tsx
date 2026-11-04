// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
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
it('다운로드 하위 구간의 완료와 미완료를 표시합니다',()=>{
 render(<StageTimings timings={[{stage:'download',startedAt:'2026-01-01T00:00:00Z',endedAt:null,elapsedMs:null,outcome:'running',estimated:false,
 details:[{step:'browser',elapsedMs:100,outcome:'completed'},{step:'receive',elapsedMs:null,outcome:'running'}]}]}/>);
 expect(screen.getByText(/브라우저 시작 · 완료 · 0.1초/)).toBeInTheDocument();
 expect(screen.getByText(/파일 수신 · 진행 중/)).toBeInTheDocument();
});
it('다운로드 세부 시간은 공통 소형 아코디언으로 접힌 상태에서 시작하고 열고 닫을 수 있습니다',()=>{
 render(<StageTimings timings={[{stage:'download',startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:02Z',elapsedMs:2000,outcome:'completed',estimated:false,
 details:[{step:'browser',elapsedMs:100,outcome:'completed'}]}]}/>);
 const summary=screen.getByText('다운로드 세부 시간');
 const details=summary.closest('details')!;
 expect(details).toHaveClass('compact-accordion');
 expect(details).not.toHaveAttribute('open');
 fireEvent.click(summary);
 expect(details).toHaveAttribute('open');
 expect(screen.getByText(/브라우저 시작 · 완료 · 0.1초/)).toBeInTheDocument();
 fireEvent.click(summary);
 expect(details).not.toHaveAttribute('open');
});
it('하위 구간이 없으면 아코디언을 렌더링하지 않습니다',()=>{
 render(<StageTimings timings={[{stage:'download',startedAt:'2026-01-01T00:00:00Z',endedAt:null,elapsedMs:100,outcome:'completed',estimated:false}]}/>);
 expect(screen.queryByText('다운로드 세부 시간')).not.toBeInTheDocument();
});
it('진행 중인 단계는 현재 시각으로 경과 시간을 갱신합니다',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:05Z'));
 render(<StageTimings timings={[{stage:'opening',startedAt:'2026-01-01T00:00:00Z',endedAt:null,elapsedMs:null,outcome:'running',estimated:false}]}/>);
 await act(()=>vi.advanceTimersByTimeAsync(1000));
 expect(screen.getByText(/진행 중 · 6.0초/)).toBeInTheDocument();
});
