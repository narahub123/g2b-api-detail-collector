import { randomUUID } from "node:crypto";
import type pg from "pg";
import { serializeError } from "../error-diagnostics";
import { redactDiagnostic } from "./collection-diagnostics";
import { noticeKeyFromParts } from "./identity";
import type { StoredNotice } from "./notices";
import { saveNoticeApiInTransaction, saveNoticeRelationInTransaction, saveStoredNoticeInTransaction } from "./postgres-store";
import type { StructuredNoticeDetail } from "./structured-data";
import type { ApiNotice } from "./types";
import { getDetailRefresh, submitDetailRefresh, type DetailSnapshot } from "./detail-refresh-store";
import { shouldReplacePaginatedDetail } from "./pagination-coverage";
import { expandCollectionRelations, finishCollectionAttempt } from "./collection-targets";
import { DocumentQueue } from "../documents/queue";
import { registerNoticeDocumentsInTransaction } from "../documents/registration";
import { QueueMeasurement, type QueueObservationContext, type QueueObservationOptions, type QueueLock } from "./queue-observation";
import type { CollectionDetailStep } from "./collection-detail-steps";
import { saveQueueObservation, logQueueObservationFailure, queueSnapshotUpdate } from "./queue-observation-store";
import type { QueueObservation } from "./queue-observation";
import { addDiagnostic, type DiagnosticStage } from "./collection-diagnostics";

export type DetailRequest = {
  key: string;
  jobId: string;
  source: "manual" | "automatic";
  purpose: "initial" | "reextract";
};
export type DetailRun = {
  id: string;
  notice_key: string;
  source: DetailRequest["source"];
  purpose: DetailRequest["purpose"];
  status: "queued" | "processing" | "succeeded" | "failed";
  owner_token: string | null;
};
type Finish = ({ status: "succeeded"; detail: NonNullable<StoredNotice["detail"]>;
  structured?: StructuredNoticeDetail; relatedKeys?: string[]; discoveredKeys?: string[]; followups?: DetailRequest[] }
  | { status: "failed"; error: string; diagnostic?: unknown }) & { snapshot?: DetailSnapshot | ((preserved: boolean) => DetailSnapshot);
    onWarning?: (message: string) => void };
const cancelledClaim = Symbol("cancelledClaim");

/** 공고 키 오류가 DB 잠금을 잡기 전에 드러나도록 검증합니다. */
function parts(key: string) {
  const [number, order, extra] = key.split("--");
  if (extra !== undefined || noticeKeyFromParts(number, order) !== key) throw new Error("잘못된 공고 키입니다.");
  return { number, order };
}

/** 요청 접수와 공고 실행을 분리하고 짧은 저장 트랜잭션에서만 임대 행을 잠급니다. */
export class DetailQueue {
  private readonly measurements = new WeakMap<pg.PoolClient, QueueMeasurement>();
  private readonly observedErrors = new WeakMap<object, "transaction" | "diagnostic">();
  /** 연결 풀과 검사된 스키마를 사용하며 기존 수집 경로는 변경하지 않습니다. */
  constructor(readonly pool: pg.Pool, readonly schema = process.env.G2B_DB_SCHEMA || "public",
    private readonly options: { legacyCollectionLock?: boolean; collectionMode?: boolean } & QueueObservationOptions = {}) {
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("잘못된 DB 스키마 이름입니다.");
  }

  /** API 생산자도 공고를 쓰기 전에 같은 큐 잠금 순서를 따르게 합니다. */
  async lockMutation(db: pg.PoolClient): Promise<void> { await this.lockLease(db); }

  /** 동일 연결에서 종료 응답까지 측정하며 확정된 결과와 원래 업무 오류를 보존합니다.
   * @param context 원본 자료와 임대 토큰을 제외한 작업 식별 정보
   * @remarks 연결 반환 오류는 별도 진단으로 남기고 COMMIT 성공을 실패로 바꾸지 않습니다.
   */
  async transaction<T>(work: (db: pg.PoolClient) => Promise<T>,
    context: QueueObservationContext = { operation: "queue.transaction", stage: "saving" }): Promise<T> {
    let db: pg.PoolClient;
    try { db = await this.pool.connect(); }
    catch (error) { await this.recordError(context, error); this.rememberError(error); throw error; }
    const measurement = new QueueMeasurement(context, this.options.monotonic);
    this.measurements.set(db, measurement);
    let success = false;
    let discardConnection = false;
    const errors: { error: unknown; operation: string }[] = [];
    try {
      await db.query("BEGIN");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query("SET LOCAL statement_timeout='15s'");
      const result = await work(db);
      const committed = await db.query("COMMIT");
      // 내부에서 처리한 SQL 오류로 COMMIT이 ROLLBACK을 반환해도 계측은 성공으로 표시하지 않습니다.
      success = committed.command !== "ROLLBACK";
      return result;
    } catch (error) {
      errors.push({ error, operation: context.operation });
      await db.query("ROLLBACK").catch(error => {
        discardConnection = true;
        errors.push({ error, operation: "queue.rollback" });
      });
      throw error;
    } finally {
      const observation = measurement.finish(success);
      this.measurements.delete(db);
      // 롤백 완료를 확인하지 못한 연결은 진단 저장이나 다음 업무에 재사용하지 않습니다.
      try { if (discardConnection) db.release(true); else db.release(); }
      catch (error) {
        // 연결 정리 실패로 이미 커밋된 작업의 재시도를 유발하지 않도록 분리합니다.
        errors.push({ error, operation: "queue.release-connection" });
      } finally {
        for (const entry of errors) {
          this.rememberError(entry.error);
          measurement.error(entry.error, entry.operation);
        }
        observation.diagnostics = measurement.diagnostics;
        // 저장 콜백은 측정 종료 후 호출하며 실패해도 업무 반환값과 예외를 바꾸지 않습니다.
        await this.publishObservation(observation);
      }
    }
  }

  /** 종료 관측은 업무 연결을 반환한 뒤 한 번만 저장하고 저장 실패는 로그로 분리합니다. */
  private async publishObservation(observation: QueueObservation): Promise<void> {
    try { await saveQueueObservation(this.pool, this.schema, observation); }
    catch (error) { logQueueObservationFailure(observation, error); }
    try { await this.options.onObservation?.(observation); }
    catch (error) { logQueueObservationFailure(observation, error); }
  }

  /** 트랜잭션 시작 전 또는 내부에서 처리한 오류도 원본 객체로 진단합니다.
   * @remarks 가상의 트랜잭션 소요 시간을 만들지 않고 오류 진단만 저장합니다.
   * @param newOccurrence 동일 객체를 다시 던지는 API 재시도도 별개의 발생으로 보존합니다.
   */
  async recordError(context: QueueObservationContext, error: unknown, stage: DiagnosticStage = "database", newOccurrence = false): Promise<void> {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      const previous = this.observedErrors.get(error);
      if (previous && (!newOccurrence || previous === "transaction")) return;
      this.observedErrors.set(error, "diagnostic");
    }
    const observation: QueueObservation = { context: { ...context, transactionId: randomUUID() },
      timings: { totals: {}, outcome: "failed" } };
    addDiagnostic(observation, { severity: "failure", stage, operation: context.operation, error });
    await this.publishObservation(observation);
  }

  /** 같은 오류 객체가 상위 처리로 전파되어도 진단 저장을 중복 실행하지 않습니다. */
  private rememberError(error: unknown): void {
    if (error !== null && (typeof error === "object" || typeof error === "function")) this.observedErrors.set(error, "transaction");
  }

  /** 같은 연결의 내부 작업만 측정하고 별도의 DB 쓰기는 만들지 않습니다. */
  async measure<T>(db: pg.PoolClient, step: CollectionDetailStep, work: () => Promise<T>): Promise<T> {
    const measurement = this.measurements.get(db);
    return measurement ? measurement.measure(step, work) : work();
  }

  /** 생산자와 소비기가 같은 트랜잭션 문맥에서 잠금 대기·점유를 기록합니다. */
  async measureLock<T extends { rowCount: number | null }>(db: pg.PoolClient, kind: QueueLock,
    work: () => Promise<T>): Promise<T> {
    const measurement = this.measurements.get(db);
    return measurement ? measurement.lock(kind, work) : work();
  }

  /** 자동 커밋 임대 SQL은 쿼리 응답까지 측정하며 별도 트랜잭션을 열지 않습니다.
   * @remarks 전체 시간에는 SQL 실행·통신·잠금 대기가 포함되며 개별 대기·점유는 추정하지 않습니다.
   */
  async statement<T>(context: QueueObservationContext, work: () => Promise<T>): Promise<T> {
    const measurement = new QueueMeasurement(context, this.options.monotonic);
    let success = false;
    let original: unknown;
    try { const value = await work(); success = true; return value; }
    catch (error) { original = error; throw error; }
    finally {
      const observation = measurement.finish(success);
      if (!success) { this.rememberError(original); measurement.error(original); }
      observation.diagnostics = measurement.diagnostics;
      await this.publishObservation(observation);
    }
  }

  /** 모든 큐 쓰기의 잠금 순서를 소비기 임대부터 시작하도록 직렬화합니다. */
  private async lockLease(db: pg.PoolClient) {
    const row = await this.measureLock(db, "worker", () => db.query(`SELECT * FROM ${this.schema}.detail_collection_worker_lease WHERE id=1 FOR UPDATE`));
    if (!row.rowCount) throw new Error("상세 큐 스키마가 준비되지 않았습니다.");
    if (this.options.legacyCollectionLock) {
      await this.measureLock(db, "legacy", async () => {
        await db.query(`INSERT INTO ${this.schema}.collection_lock(id) VALUES(1) ON CONFLICT DO NOTHING`);
        return db.query(`SELECT id FROM ${this.schema}.collection_lock WHERE id=1 FOR UPDATE`);
      });
    }
  }

  /** 임대 행 잠금을 유지한 연결에서 토큰과 현재 유효기간을 검사합니다. */
  private async owned(db: pg.PoolClient, token: string) {
    const row = await db.query(`SELECT 1 FROM ${this.schema}.detail_collection_worker_lease
      WHERE id=1 AND owner_token=$1 AND expires_at>clock_timestamp()`, [token]);
    if (!row.rowCount) throw new Error("상세 소비기 임대 소유권을 잃었습니다.");
    if (this.options.legacyCollectionLock) {
      const legacy = await db.query(`SELECT 1 FROM ${this.schema}.collection_lock
        WHERE id=1 AND job_id=$1 AND token=$1 AND expires_at>clock_timestamp()`, [token]);
      if (!legacy.rowCount) throw new Error("기존 수집과의 호환 잠금 소유권을 잃었습니다.");
    }
  }

  /** 공고 자리표시자를 확보하며 기존 API와 상세는 수정하지 않습니다. */
  private async ensureNotice(db: pg.PoolClient, key: string) {
    const { number, order } = parts(key);
    await db.query(`INSERT INTO ${this.schema}.notices(key,notice_number,notice_order)
      VALUES($1,$2,$3) ON CONFLICT(key) DO NOTHING`, [key, number, order]);
  }

  /** 다른 소비기의 유효한 임대를 빼앗지 않고 단일 실행권을 얻습니다. */
  async acquire(token: string): Promise<boolean> {
    if (this.options.legacyCollectionLock) return this.transaction(async db => {
      await this.lockLease(db);
      const lease = await db.query(`SELECT 1 FROM ${this.schema}.detail_collection_worker_lease
        WHERE id=1 AND (owner_token IS NULL OR expires_at<=clock_timestamp())`);
      const legacy = await db.query(`SELECT 1 FROM ${this.schema}.collection_lock
        WHERE id=1 AND (job_id IS NULL OR expires_at<=clock_timestamp())`);
      if (!lease.rowCount || !legacy.rowCount) return false;
      await db.query(`UPDATE ${this.schema}.detail_collection_worker_lease
        SET owner_token=$1,expires_at=clock_timestamp()+interval '120 seconds' WHERE id=1`, [token]);
      await db.query(`UPDATE ${this.schema}.collection_lock SET job_id=$1,token=$1,
        expires_at=clock_timestamp()+interval '120 seconds' WHERE id=1`, [token]);
      return true;
    }, { operation: 'detail.acquire', stage: 'saving' });
    const row = await this.statement({ operation: 'detail.acquire', stage: 'saving' }, () => this.pool.query(`UPDATE ${this.schema}.detail_collection_worker_lease
      SET owner_token=$1,expires_at=clock_timestamp()+interval '120 seconds'
      WHERE id=1 AND (owner_token IS NULL OR expires_at<=clock_timestamp()) RETURNING id`, [token]));
    return !!row.rowCount;
  }

  /** 만료된 소비기가 새 소유권을 갱신할 수 없도록 제한합니다.
   * @param runId 진단 귀속에만 사용하며 임대 소유권 검사에는 사용하지 않습니다.
   */
  async renew(token: string, runId?: string): Promise<boolean> {
    if (this.options.legacyCollectionLock) return this.transaction(async db => {
      await this.lockLease(db);
      try { await this.owned(db, token); }
      catch (error) { this.measurements.get(db)?.error(error, "detail.renew-ownership"); return false; }
      await db.query(`UPDATE ${this.schema}.detail_collection_worker_lease
        SET expires_at=clock_timestamp()+interval '120 seconds' WHERE id=1`, []);
      await db.query(`UPDATE ${this.schema}.collection_lock SET expires_at=clock_timestamp()+interval '120 seconds' WHERE id=1`);
      return true;
    }, { operation: 'detail.renew', stage: 'saving', runId });
    const row = await this.statement({ operation: 'detail.renew', stage: 'saving', runId }, () => this.pool.query(`UPDATE ${this.schema}.detail_collection_worker_lease
      SET expires_at=clock_timestamp()+interval '120 seconds'
      WHERE id=1 AND owner_token=$1 AND expires_at>clock_timestamp() RETURNING id`, [token]));
    return !!row.rowCount;
  }

  /** 자신의 소비기 임대만 반환하며 새 소유자의 임대는 보존합니다.
   * @param runId 진단 귀속에만 사용하며 임대 반환 조건에는 사용하지 않습니다.
   */
  async release(token: string, runId?: string): Promise<void> {
    if (this.options.legacyCollectionLock) {
      await this.transaction(async db => {
        await this.lockLease(db);
        await db.query(`UPDATE ${this.schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL
          WHERE id=1 AND owner_token=$1`, [token]);
        await db.query(`UPDATE ${this.schema}.collection_lock SET job_id=NULL,token=NULL,expires_at=NULL
          WHERE id=1 AND job_id=$1 AND token=$1`, [token]);
      }, { operation: 'detail.release', stage: 'saving', runId });
      return;
    }
    await this.statement({ operation: 'detail.release', stage: 'saving', runId }, () => this.pool.query(`UPDATE ${this.schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL
      WHERE id=1 AND owner_token=$1`, [token]));
  }

  /** 이미 시작한 트랜잭션에 요청을 연결하여 API 저장과 접수를 함께 확정합니다.
   * @remarks 다른 행을 쓰기 전에 호출해야 임대→실행→공고의 잠금 순서를 유지합니다.
   */
  async enqueueInTransaction(db: pg.PoolClient, request: DetailRequest): Promise<DetailRun> {
    parts(request.key);
    await this.lockLease(db);
    const active = (await db.query<DetailRun>(`SELECT * FROM ${this.schema}.detail_collection_runs
      WHERE notice_key=$1 AND status IN ('queued','processing') FOR UPDATE`, [request.key])).rows[0];
    let run = active;
    // API 재발견이 실패 복구 대기를 최초 수집으로 되돌리지 않도록 기존 목적은 유지합니다.
    if (active?.status === "queued" && request.source === "manual") {
      // 새 직접 요청은 자동 재시도의 지연 시각도 해제하여 다음 선점부터 처리합니다.
      run = (await db.query<DetailRun>(`UPDATE ${this.schema}.detail_collection_runs SET source='manual',next_attempt_at=NULL
        WHERE id=$1 RETURNING *`, [active.id])).rows[0];
    }
    if (!run) {
      await this.ensureNotice(db, request.key);
      run = (await db.query<DetailRun>(`INSERT INTO ${this.schema}.detail_collection_runs
        (id,notice_key,source,purpose) VALUES($1,$2,$3,$4) RETURNING *`,
      [randomUUID(), request.key, request.source, request.purpose])).rows[0];
    }
    await db.query(`INSERT INTO ${this.schema}.detail_collection_requests(job_id,run_id)
      VALUES($1,$2) ON CONFLICT DO NOTHING`, [request.jobId, run.id]);
    return run;
  }

  /** 같은 공고의 활성 실행을 공유하고 대기 중인 자동 요청을 직접 요청으로 승격합니다. */
  async enqueue(request: DetailRequest): Promise<DetailRun> {
    return this.transaction(db => this.enqueueInTransaction(db, request), { operation: "detail.enqueue", stage: "saving", jobId: request.jobId });
  }

  /** 준비된 요청 중 직접·자동 최초·자동 보완 순서로 공고 하나를 선점합니다. */
  async claim(token: string, signal?: AbortSignal): Promise<DetailRun | null> {
    try { return await this.transaction(async db => {
      await this.lockLease(db);
      await this.owned(db, token);
      if (signal?.aborted) return null;
      // 공고마다 다시 선택하므로 새 직접 요청이 기존 자동 대기보다 먼저 실행됩니다.
      const run = (await db.query<DetailRun>(`SELECT * FROM ${this.schema}.detail_collection_runs
        WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp())
        ORDER BY CASE WHEN source='manual' THEN 0 WHEN purpose='initial' THEN 1 ELSE 2 END,requested_at,id
        LIMIT 1 FOR UPDATE`)).rows[0];
      if (!run) return null;
      const measurement = this.measurements.get(db);
      if (measurement) measurement.context.runId = run.id;
      await db.query(`SELECT key FROM ${this.schema}.notices WHERE key=$1 FOR UPDATE`, [run.notice_key]);
      const claimed = (await db.query<DetailRun>(`UPDATE ${this.schema}.detail_collection_runs
        SET status='processing',owner_token=$2,started_at=clock_timestamp(),next_attempt_at=NULL
        WHERE id=$1 RETURNING *`, [run.id, token])).rows[0];
      await this.owned(db, token);
      if (signal?.aborted) throw cancelledClaim;
      return claimed;
    }, { operation: "detail.claim", stage: "saving" }); } catch (error) {
      if (error === cancelledClaim) return null;
      throw error;
    }
  }

  /** 모든 상세 쓰기를 같은 연결의 임대→실행→공고 잠금 아래 수행합니다.
   * @param work 외부 통신 없이 전달된 연결만 사용하는 짧은 DB 작업
   * @param context 저장 작업 종류와 실행 식별자이며 계측에만 사용합니다.
   * @throws 소비기 임대 또는 공고 실행의 소유권을 잃으면 전체 저장을 롤백합니다.
   */
  async withRun<T>(token: string, id: string,
    work: (db: pg.PoolClient, run: DetailRun, current: StoredNotice) => Promise<T>,
    context: QueueObservationContext = { operation: "detail.with-run", stage: "saving", runId: id }): Promise<T> {
    return this.transaction(async db => {
      await this.lockLease(db);
      await this.owned(db, token);
      const run = (await db.query<DetailRun>(`SELECT * FROM ${this.schema}.detail_collection_runs WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!run || run.status !== "processing" || run.owner_token !== token) throw new Error("공고 실행 소유권을 잃었습니다.");
      const row = (await db.query(`SELECT api,detail,detail_error,detail_diagnostic FROM ${this.schema}.notices
        WHERE key=$1 FOR UPDATE`, [run.notice_key])).rows[0];
      if (!row) throw new Error("상세 수집 공고가 없습니다.");
      const result = await work(db, run, { api: row.api, detail: row.detail,
        detailError: row.detail_error, detailDiagnostic: row.detail_diagnostic });
      // 긴 DB 저장 중 임대가 만료되어도 결과를 확정하지 않습니다.
      await this.owned(db, token);
      return result;
    }, context);
  }

  /** 관측 중간 상태에도 공고 실행 소유권을 적용합니다. */
  async progress(token: string, id: string, progress: Record<string, unknown>): Promise<void> {
    await this.withRun(token, id, async db => {
      await db.query(`UPDATE ${this.schema}.detail_collection_runs SET progress=${queueSnapshotUpdate("progress", "$2")} WHERE id=$1`,
        [id, JSON.stringify(progress)]);
    }, { operation: 'detail.progress', stage: 'saving', runId: id });
  }

  /** 중간 오류를 최신 원본과 병합하여 성공 상세를 보존합니다. */
  async saveError(token: string, id: string, error: string, diagnostic?: unknown): Promise<void> {
    await this.withRun(token, id, async (db, run, current) => {
      await this.measure(db, "queue.detail.save", () => saveStoredNoticeInTransaction(db, run.notice_key, { ...current,
        detailError: redactDiagnostic(error), detailDiagnostic: diagnostic ? serializeError(diagnostic) : null }, undefined, this.schema));
    }, { operation: 'detail.saveError', stage: 'saving', runId: id });
  }

  /** 중간 관계 저장도 소유권을 검사하고 같은 트랜잭션에서 반영합니다. */
  async saveRelations(token: string, id: string, keys: string[]): Promise<void> {
    await this.withRun(token, id, async (db, run) => {
      await this.measure(db, "queue.relations.save", async () => {
        for (const key of [...new Set(keys)].sort()) await saveNoticeRelationInTransaction(db, run.notice_key, key, this.schema);
      });
    }, { operation: 'detail.saveRelations', stage: 'saving', runId: id });
  }

  /** API 생산자가 현재 상세·오류를 보존하면서 API 원본과 요약만 갱신합니다. */
  async saveApiInTransaction(db: pg.PoolClient, key: string, api: ApiNotice): Promise<void> {
    parts(key);
    await this.measure(db, "queue.api.save", () => saveNoticeApiInTransaction(db, key, api, this.schema));
  }

  /** 단독 API 갱신을 짧은 트랜잭션으로 확정합니다. */
  async saveApi(key: string, api: ApiNotice): Promise<void> {
    await this.transaction(db => this.saveApiInTransaction(db, key, api), { operation: "detail.save-api", stage: "saving" });
  }

  /** 상세·참조·후속 요청과 실행 종료를 저장하고 PDF 등록 실패는 복구 기록으로 분리합니다. */
  async finish(token: string, id: string, result: Finish): Promise<void> {
    await this.withRun(token, id, async (db, run, current) => {
      const preserved = result.status === "succeeded" && !!current.detail && !shouldReplacePaginatedDetail(current.detail, result.detail);
      if (result.status === "succeeded" && !preserved) {
        await this.measure(db, "queue.detail.save", () => saveStoredNoticeInTransaction(db, run.notice_key,
          { ...current, detail: result.detail, detailError: null, detailDiagnostic: null }, result.structured, this.schema));
        await this.measure(db, "queue.relations.save", async () => {
          for (const key of [...new Set(result.relatedKeys ?? [])].sort())
            await saveNoticeRelationInTransaction(db, run.notice_key, key, this.schema);
          for (const request of result.followups ?? []) await this.enqueueInTransaction(db, request);
          if (this.options.collectionMode) await expandCollectionRelations(db, this, run, result.discoveredKeys ?? [], result.onWarning ?? (() => undefined));
        });
      } else if (result.status === "failed") {
        await this.measure(db, "queue.detail.save", () => saveStoredNoticeInTransaction(db, run.notice_key, { ...current,
          detailError: redactDiagnostic(result.error), detailDiagnostic: result.diagnostic ? serializeError(result.diagnostic) : null }, undefined, this.schema));
      }
      if (result.status === "succeeded") {
        await this.measure(db, "queue.documents.register", () => registerNoticeDocumentsInTransaction(new DocumentQueue(this.pool, this.schema), db, run.notice_key));
      }
      // 실제 자료 저장까지의 시간을 관측에 포함하고 같은 커밋으로 종료 상태와 확정합니다.
      const snapshot = typeof result.snapshot === "function" ? result.snapshot(preserved) : result.snapshot;
      await db.query(`UPDATE ${this.schema}.detail_collection_runs SET status=$2,owner_token=NULL,
        finished_at=clock_timestamp(),error=$3,diagnostic=$4::jsonb,progress=${queueSnapshotUpdate("progress", "$5")} WHERE id=$1`, [id, result.status,
        result.status === "failed" ? redactDiagnostic(result.error) : null,
        result.status === "failed" && result.diagnostic ? JSON.stringify(serializeError(result.diagnostic)) : null,
        snapshot ? JSON.stringify(snapshot) : null]);
      if (this.options.collectionMode) await finishCollectionAttempt(db, this, run, result.status,
        result.status === "failed" ? redactDiagnostic(result.error) : null,
        result.status === "failed" && result.diagnostic ? JSON.stringify(serializeError(result.diagnostic)) : null, preserved);
    }, { operation: 'detail.finish', stage: 'saving', runId: id });
  }

  /** 점검으로 중단된 공고를 실패 처리하지 않고 잠시 뒤 재개할 수 있도록 반환합니다. */
  async defer(token: string, id: string, snapshot: DetailSnapshot): Promise<void> {
    await this.withRun(token, id, async db => {
      await db.query(`UPDATE ${this.schema}.detail_collection_runs SET status='queued',owner_token=NULL,
        started_at=NULL,next_attempt_at=clock_timestamp()+interval '60 seconds',progress=${queueSnapshotUpdate("progress", "$2")} WHERE id=$1`,
      [id, JSON.stringify(snapshot)]);
    }, { operation: 'detail.defer', stage: 'saving', runId: id });
  }

  /** 종료 신호 직후 선점한 공고를 실패나 지연 없이 원래 대기 순서로 반환합니다. */
  async returnClaim(token: string, id: string): Promise<void> {
    await this.withRun(token, id, async db => {
      await db.query(`UPDATE ${this.schema}.detail_collection_runs SET status='queued',owner_token=NULL,
        started_at=NULL,progress=${queueSnapshotUpdate("progress", "empty")} WHERE id=$1`, [id]);
    }, { operation: 'detail.returnClaim', stage: 'saving', runId: id });
  }

  /** 선택 재수집의 접수와 공유 실행 연결을 원자적으로 저장합니다. */
  async submitRefresh(keys: string[]) { return submitDetailRefresh(this, keys); }

  /** 요청 작업을 실행 결과에서 집계하여 반환합니다. */
  async getRefreshJob(id: string) { return getDetailRefresh(this, id); }

  /** 최신 큐 수집 작업을 읽어 웹 재접속 시 API·상세 대기를 복원합니다. */
  async latestRefreshJob() {
    const row = (await this.pool.query(`SELECT id FROM ${this.schema}.detail_collection_jobs ORDER BY requested_at DESC,id DESC LIMIT 1`)).rows[0];
    return row ? this.getRefreshJob(row.id) : null;
  }

  /** 새 소비기가 이전 실행의 미완료 공고를 실패 횟수 증가 없이 대기로 돌립니다. */
  async recover(token: string): Promise<number> {
    return this.transaction(async db => {
      await this.lockLease(db);
      await this.owned(db, token);
      const rows = await db.query(`UPDATE ${this.schema}.detail_collection_runs
        SET status='queued',owner_token=NULL,started_at=NULL,progress=${queueSnapshotUpdate("progress", "empty")}
        WHERE status='processing' AND owner_token<>$1`, [token]);
      await this.owned(db, token);
      return rows.rowCount ?? 0;
    }, { operation: "detail.recover", stage: "saving" });
  }
}
