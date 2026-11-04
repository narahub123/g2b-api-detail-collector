// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CollectionStageTimings, CollectionTimingClock } from "./CollectionStageTimings";
import type { CollectionTimings } from "@/lib/g2b/collection-timings";

afterEach(cleanup);

it("API·저장의 큐 세부 항목과 근사·중첩 안내를 기존 아코디언에 표시합니다", () => {
  render(<CollectionStageTimings label="큐 시간" running={false} timings={{ outcome: "completed", totals: { saving: 40 },
    details: { api: { active: [], steps: { "queue.producer-lock.wait": { elapsedMs: 20, count: 1, maxMs: 20, outcomes: { failed: 1 } } } },
      saving: { active: [], steps: { "queue.worker-lock.hold": { elapsedMs: 100, count: 1, maxMs: 100, outcomes: { completed: 1 } } } } } }} />);
  expect(screen.getAllByText("세부 작업 시간")).toHaveLength(2);
  expect(screen.getByText("API 생산자 임대 잠금 대기")).toBeInTheDocument();
  expect(screen.getByText("상세 큐 임대 잠금 점유")).toBeInTheDocument();
  expect(screen.getByText("세부 계측만 있음")).toBeInTheDocument();
  expect(screen.getAllByText(/서로 겹칠 수 있어 합산하지 않습니다/)).toHaveLength(2);
  expect(screen.getAllByText(/애플리케이션 기준 근사값/)).toHaveLength(2);
  expect(within(row("결과 저장")).getByText("40ms")).toBeInTheDocument();
});

it('세부 구간의 집계와 시간 초과·미완료를 펼침 영역에 표시합니다',()=>{
  render(<CollectionStageTimings label="상세 시간" running={false} timings={{outcome:'interrupted',totals:{modals:500},details:{modals:{
    steps:{'modal.wait-settled':{elapsedMs:500,count:2,maxMs:400,outcomes:{timeout:1,interrupted:1}}},active:[],
  }}}}/>);
  expect(screen.getByText('세부 작업 시간')).toBeInTheDocument();
  expect(screen.getByText('데이터 안정화 대기')).toBeInTheDocument();
  expect(screen.getByText('2회')).toBeInTheDocument();
  expect(screen.getByText('400ms')).toBeInTheDocument();
  expect(screen.getByText(/시간 초과 1회/)).toBeInTheDocument();
  expect(screen.getByText(/중단 · 미완료 1회/)).toBeInTheDocument();
});

it('실행 중인 세부 작업은 후보와 깊이를 표시하고 과거 기록에는 상세를 만들지 않습니다',()=>{
  const {rerender}=render(<CollectionStageTimings label="상세 시간" running timings={{outcome:'running',totals:{},details:{modals:{steps:{},active:[{
    id:'span',step:'modal.open',startedAt:'2026-11-03T00:00:00Z',lastObservedAt:'2026-11-03T00:00:00Z',elapsedMs:50,context:{candidateId:'button-1',depth:2},
  }]}}}}/>);
  expect(screen.getByText(/button-1/)).toBeInTheDocument();
  expect(screen.getByText(/깊이 2/)).toBeInTheDocument();
  expect(screen.getByText(/진행 중 · 50ms/)).toBeInTheDocument();
  rerender(<CollectionStageTimings label="상세 시간" running={false} timings={{outcome:'completed',totals:{opening:100}}}/>);
  expect(screen.queryByText('세부 작업 시간')).not.toBeInTheDocument();
});

/** 단계 이름으로 행을 골라 서로 다른 검사 시간이 섞이지 않는지 확인합니다. */
function row(name: string): HTMLElement {
  return screen.getByRole("rowheader", { name }).closest("tr")!;
}

it("두 검사 시간과 미실행을 구분하고 짧은 측정값은 밀리초로 표시합니다", () => {
  render(<CollectionStageTimings label="작업 시간" running={false} timings={{ outcome: "completed", totals: {
    extracting: 1500, "extraction-check": 0.25, "preservation-check": 0,
  } }} />);
  expect(within(row("본문 추출")).getByText("1.50초")).toBeInTheDocument();
  expect(within(row("추출 누락 검사")).getByText("0.25ms")).toBeInTheDocument();
  expect(within(row("구조화 보존 검사")).getByText("0ms")).toBeInTheDocument();
  expect(within(row("구조화 보존 검사")).getByText("측정 완료")).toBeInTheDocument();
  expect(within(row("표 수집")).getByText("미실행")).toBeInTheDocument();
});

it("과거 자료는 미실행으로 추정하지 않고 기록 없음으로 표시합니다", () => {
  render(<CollectionStageTimings label="과거 작업 시간" running={false} />);
  expect(screen.getByText("단계별 처리 시간: 기록 없음")).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByText("미실행")).not.toBeInTheDocument();
});

it("기존 누적과 저장된 현재 구간에 마지막 관측 이후 시간만 더합니다", () => {
  const observed = Date.parse("2026-11-03T00:00:02Z");
  const timings: CollectionTimings = { outcome: "running", totals: { opening: 1000, extracting: 250 },
    active: { stage: "opening", startedAt: "2026-11-03T00:00:00Z", lastObservedAt: new Date(observed).toISOString(), elapsedMs: 200 } };
  /** 같은 시계 문맥을 바꿔 진행 중인 구간만 늘어나는지 검증합니다. */
  const view = (now: number, running = true, data = timings) => <CollectionTimingClock.Provider value={now}>
    <CollectionStageTimings label="현재 작업 시간" running={running} timings={data} />
  </CollectionTimingClock.Provider>;
  const { rerender } = render(view(observed + 1000));
  expect(within(row("상세 화면 열기")).getByText("2.20초")).toBeInTheDocument();
  expect(within(row("상세 화면 열기")).getByText("진행 중")).toBeInTheDocument();
  rerender(view(observed + 2000));
  expect(within(row("상세 화면 열기")).getByText("3.20초")).toBeInTheDocument();
  expect(within(row("본문 추출")).getByText("250ms")).toBeInTheDocument();
  const finished: CollectionTimings = { outcome: "completed", totals: { opening: 3200, extracting: 250 } };
  rerender(view(observed + 10000, false, finished));
  expect(within(row("상세 화면 열기")).getByText("3.20초")).toBeInTheDocument();
  expect(screen.queryByText("진행 중")).not.toBeInTheDocument();
});

it("종료되지 않은 스냅샷은 작업 종료 뒤 현재 시각까지 연장하지 않습니다", () => {
  render(<CollectionTimingClock.Provider value={Date.parse("2026-11-03T01:00:00Z")}>
    <CollectionStageTimings label="중단 작업 시간" running={false} timings={{ outcome: "running", totals: { modals: 100 },
      active: { stage: "modals", startedAt: "2026-11-03T00:00:00Z", lastObservedAt: "2026-11-03T00:00:01Z", elapsedMs: 250 } }} />
  </CollectionTimingClock.Provider>);
  expect(within(row("모달 수집")).getByText("350ms")).toBeInTheDocument();
  expect(within(row("모달 수집")).getByText("종료 미확인")).toBeInTheDocument();
});

it("중단 추정은 기록값으로 표시하고 미실행 검사에는 시간을 만들지 않습니다", () => {
  render(<CollectionStageTimings label="중단 작업 시간" running={false}
    timings={{ outcome: "interrupted", estimated: true, totals: { modals: 350 } }} />);
  expect(screen.getByText(/중단 추정/)).toBeInTheDocument();
  expect(within(row("모달 수집")).getByText("350ms")).toBeInTheDocument();
  expect(within(row("추출 누락 검사")).getByText("미실행")).toBeInTheDocument();
});

it("초기 렌더는 저장값만 사용하고 극히 짧은 실행도 0으로 지우지 않습니다", () => {
  render(<CollectionStageTimings label="초기 시간" running timings={{ outcome: "running", totals: { "extraction-check": 0.003 },
    active: { stage: "opening", startedAt: "2026-11-03T00:00:00Z", lastObservedAt: "2026-11-03T00:00:01Z", elapsedMs: 200 } }} />);
  expect(within(row("상세 화면 열기")).getByText("200ms")).toBeInTheDocument();
  expect(within(row("추출 누락 검사")).getByText("<0.01ms")).toBeInTheDocument();
});

it.each(["completed", "failed", "deferred", "interrupted"] as const)("%s 기록은 다른 공고의 화면 시계가 움직여도 고정합니다", outcome => {
  /** 다른 공고가 실행 중인 화면에서도 종료된 구간을 연장하지 않습니다. */
  const view = (now: number) => <CollectionTimingClock.Provider value={now}>
    <CollectionStageTimings label="종료 공고 시간" running timings={{ outcome, totals: { saving: 25 } }} />
  </CollectionTimingClock.Provider>;
  const { rerender } = render(view(1000));
  rerender(view(100000));
  expect(within(row("결과 저장")).getByText("25ms")).toBeInTheDocument();
  expect(screen.queryByText("진행 중")).not.toBeInTheDocument();
});

it("opening과 modals 세부 작업 시간에 공통 소형 아코디언을 적용하고 각각 접고 펼칩니다", () => {
  render(<CollectionStageTimings label="상세 시간" running={false} timings={{
    outcome:"completed",totals:{opening:100,modals:200},details:{
      opening:{steps:{},active:[]},
      modals:{steps:{"modal.wait-settled":{elapsedMs:200,count:1,maxMs:200,outcomes:{settled:1}}},active:[]},
    },
  }}/>);
  const summaries=screen.getAllByText("세부 작업 시간");
  expect(summaries).toHaveLength(2);
  for(const summary of summaries){
    const details=summary.closest("details")!;
    expect(details).toHaveClass("compact-accordion");
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).toHaveAttribute("open");
    fireEvent.click(summary);
    expect(details).not.toHaveAttribute("open");
  }
  expect(within(row("모달 수집")).getByRole("table",{name:"세부 작업 시간 집계"})).toBeInTheDocument();
  expect(within(row("상세 화면 열기")).queryByRole("table",{name:"세부 작업 시간 집계"})).not.toBeInTheDocument();
});
