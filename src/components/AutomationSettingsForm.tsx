"use client";

import { useEffect, useState } from "react";
import type { AutomationSettings } from "@/lib/g2b/automation-schedule";

/** UTC로 저장된 예약 기준을 서울 시각으로 표시합니다. */
function seoulText(value: string | null): string {
  if (!value) return "없음";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value));
}

/** 자동 수집 활성화와 주기·다중 예약 시각을 관리자 화면에서 편집합니다. */
export function AutomationSettingsForm({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [schedule, setSchedule] = useState<"interval" | "times">("interval");
  const [intervalMinutes, setIntervalMinutes] = useState<30 | 60 | 120 | 180>(60);
  const [times, setTimes] = useState<string[]>([]);
  const [startAt, setStartAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void fetcher("/api/automation", { cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "자동 설정을 읽지 못했습니다.");
      return body as AutomationSettings;
    }).then((loaded) => {
      setSettings(loaded);
      setEnabled(loaded.enabled);
      setSchedule(loaded.schedule);
      setIntervalMinutes(loaded.intervalMinutes);
      setTimes(loaded.times);
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "자동 설정 오류"));
  }, [fetcher]);

  /** 현재 선택값을 저장하고 새 활성화 시각을 다시 입력받습니다. */
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const activating = enabled && !settings?.enabled;
      const input = { enabled, schedule, intervalMinutes, times,
        ...(activating ? { startAt } : {}) };
      const response = await fetcher("/api/automation", { method: "PUT",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "자동 설정을 저장하지 못했습니다.");
      setSettings(body as AutomationSettings);
      setStartAt("");
      setMessage("자동 수집 설정을 저장했습니다.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "자동 설정 오류");
    } finally { setBusy(false); }
  }

  return <section className="collect-panel automation-panel" aria-labelledby="automation-heading">
    <div className="panel-copy"><span className="eyebrow">AUTOMATION</span>
      <h2 id="automation-heading">자동 수집 설정</h2>
      <p>예약 시각은 서울 시각을 사용합니다. 진행 중인 작업은 설정을 꺼도 완료될 때까지 계속됩니다.</p></div>
    <p className="automation-summary">외부 예약 호출은 다음 단계에서 연결합니다. 현재는 설정 저장 후 명령을 직접 호출해야 실행됩니다.</p>
    {settings && <p className="automation-summary">현재 {settings.enabled ? "활성화" : "비활성화"} · 조회 시작 {seoulText(settings.startAt)}
      {settings.lastDueAt && <> · 마지막 예약 {seoulText(settings.lastDueAt)}</>}</p>}
    {settings && <form className="automation-form" onSubmit={submit}>
      <label className="automation-switch"><input type="checkbox" checked={enabled}
        onChange={(event) => setEnabled(event.target.checked)} />자동 수집 사용</label>
      {enabled && !settings.enabled && <label>조회 시작 (서울 시각)
        <input type="datetime-local" value={startAt} required onChange={(event) => setStartAt(event.target.value)} /></label>}
      <label>실행 방식<select value={schedule} onChange={(event) => {
        const next = event.target.value as "interval" | "times";
        setSchedule(next);
        if (next === "times" && times.length === 0) setTimes(["09:00"]);
      }}><option value="interval">주기</option><option value="times">지정 시각</option></select></label>
      {schedule === "interval" ? <label>수집 주기<select value={intervalMinutes}
        onChange={(event) => setIntervalMinutes(Number(event.target.value) as 30 | 60 | 120 | 180)}>
        <option value={30}>30분</option><option value={60}>1시간</option><option value={120}>2시간</option><option value={180}>3시간</option>
      </select></label> : <div className="automation-times"><span>하루 예약 시각</span>
        {times.map((time, index) => <div className="automation-time-row" key={index}>
          <label>예약 시각 {index + 1}<input type="time" value={time} required
            onChange={(event) => setTimes((current) => current.map((item, position) => position === index ? event.target.value : item))} /></label>
          <button type="button" onClick={() => setTimes((current) => current.filter((_, position) => position !== index))}
            disabled={times.length === 1}>삭제</button>
        </div>)}
        <button type="button" onClick={() => setTimes((current) => [...current, "09:00"])} disabled={times.length >= 24}>시각 추가</button>
      </div>}
      <button className="automation-save" type="submit" disabled={busy}>{busy ? "저장 중…" : "설정 저장"}</button>
    </form>}
    {error && <p role="alert" className="error-message">{error}</p>}
    {message && <p role="status" className="automation-success">{message}</p>}
  </section>;
}
