import { getPool } from "./postgres-store";
import { applyAutomationSettings, latestDueTime, type AutomationInput, type AutomationSettings } from "./automation-schedule";

type SettingsRow = { enabled: boolean; schedule: AutomationSettings["schedule"];
  interval_minutes: AutomationSettings["intervalMinutes"]; times: string[];
  start_at: string | null; activated_at: string | null; activation_id: string | null; last_due_at: string | null };

export type ScheduledClaim = { kind: "disabled" | "not_due" } | {
  kind: "due"; settings: AutomationSettings; dueAt: string;
};

/** 설정 스키마를 검증해 단일 설정 행의 테이블 이름을 반환합니다. */
function settingsTable(): string {
  const schema = process.env.G2B_DB_SCHEMA || "public";
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("잘못된 DB 스키마 이름입니다.");
  return `${schema}.collection_automation`;
}

const fields = `enabled,schedule,interval_minutes,times,
  to_char(start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS start_at,
  to_char(activated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS activated_at,
  activation_id::text AS activation_id,
  to_char(last_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_due_at`;

/** DB 행을 관리자 API와 예약 계산에 쓰는 설정으로 바꿉니다. */
function fromRow(row: SettingsRow): AutomationSettings {
  return { enabled: row.enabled, schedule: row.schedule, intervalMinutes: row.interval_minutes,
    times: row.times, startAt: row.start_at, activatedAt: row.activated_at,
    activationId: row.activation_id, lastDueAt: row.last_due_at };
}

/** 현재 자동 수집 설정을 읽습니다. */
export async function getAutomationSettings(): Promise<AutomationSettings> {
  const result = await getPool().query<SettingsRow>(`SELECT ${fields} FROM ${settingsTable()} WHERE id=1`);
  if (!result.rows[0]) throw new Error("자동 수집 설정 행이 없습니다. DB 스키마를 적용하세요.");
  return fromRow(result.rows[0]);
}

/** 설정 변경과 활성화 기준점 갱신을 하나의 DB 트랜잭션으로 저장합니다. */
export async function updateAutomationSettings(input: AutomationInput, now = new Date()): Promise<AutomationSettings> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<SettingsRow>(`SELECT ${fields} FROM ${settingsTable()} WHERE id=1 FOR UPDATE`);
    if (!current.rows[0]) throw new Error("자동 수집 설정 행이 없습니다. DB 스키마를 적용하세요.");
    const next = applyAutomationSettings(fromRow(current.rows[0]), input, now);
    await client.query(`UPDATE ${settingsTable()} SET enabled=$1,schedule=$2,interval_minutes=$3,times=$4,
      start_at=$5::timestamptz,activated_at=$6::timestamptz,activation_id=$7::uuid,
      last_due_at=$8::timestamptz,updated_at=now() WHERE id=1`,
    [next.enabled, next.schedule, next.intervalMinutes, next.times, next.startAt,
      next.activatedAt, next.activationId, next.lastDueAt]);
    await client.query("COMMIT");
    return next;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** 같은 예약을 두 실행기가 중복 처리하지 않도록 DB 행을 잠가 예약 시각을 선점합니다. */
export async function claimScheduledRun(now = new Date()): Promise<ScheduledClaim> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<SettingsRow>(`SELECT ${fields} FROM ${settingsTable()} WHERE id=1 FOR UPDATE`);
    if (!selected.rows[0]) throw new Error("자동 수집 설정 행이 없습니다. DB 스키마를 적용하세요.");
    const settings = fromRow(selected.rows[0]);
    if (!settings.enabled) { await client.query("COMMIT"); return { kind: "disabled" }; }
    const dueAt = latestDueTime(settings, now);
    if (!dueAt) { await client.query("COMMIT"); return { kind: "not_due" }; }
    await client.query(`UPDATE ${settingsTable()} SET last_due_at=$1::timestamptz,updated_at=now() WHERE id=1`, [dueAt]);
    await client.query("COMMIT");
    return { kind: "due", settings: { ...settings, lastDueAt: dueAt }, dueAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
