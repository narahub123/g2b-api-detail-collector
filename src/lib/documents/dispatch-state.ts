import { randomUUID } from "node:crypto";
import type pg from "pg";
import { downloadableAttachmentSql } from "../g2b/attachment-sql";
import { fixedAttachmentExclusionSql } from "../g2b/attachment-exclusions";
import type { DispatchResponse } from "./dispatch";

export type DispatchClaim = { reason: "claimed"; token: string; generation: string }
  | { reason: "idle" | "cooldown" | "in_flight" | "worker_busy" | "delayed" };

/** 저장소 이름을 고정된 GitHub 경로에 안전하게 사용할 수 있도록 정규화합니다. */
export function normalizeDispatchRepository(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value) ? value.toLowerCase() : undefined;
}

/** 등록·자동 실행·진행 호출을 모두 활성화한 환경에서만 새 요청 세대를 남깁니다. */
export function dispatchRepository(env: Record<string,string|undefined> = process.env): string | undefined {
  if (env.DETAIL_PDF_REGISTRATION_ENABLED !== "true" || env.PDF_PROGRESS_DISPATCH_ENABLED !== "true" || env.G2B_PDF_EXTRACTION_ENABLED !== "true") return;
  const repository=normalizeDispatchRepository(env.PDF_DISPATCH_REPOSITORY || env.GITHUB_REPOSITORY);
  if (env.GITHUB_ACTIONS==="true" && (env.GITHUB_REF!=="refs/heads/main" || normalizeDispatchRepository(env.GITHUB_REPOSITORY)!==repository)) return;
  return repository;
}

/** 호출 선점과 성공 확인이 같은 유효 문서·현재 체인 기준으로 대기 요청을 판정합니다. */
function eligibleQueuedPdfSql(schema: string): string {
  return `FROM ${schema}.attachment_extraction_runs r
    JOIN ${schema}.attachment_documents d ON d.current_run_id=r.id AND d.active_chain_id=r.chain_id
    WHERE r.status='queued' AND d.is_current AND r.invalidated_at IS NULL
      AND r.attachment_revision=d.attachment_revision AND r.attachment_url=d.attachment_url
      AND ${downloadableAttachmentSql('d.attachment_url')} AND ${fixedAttachmentExclusionSql('d.file_no::text','d.seq')}`;
}

/** 짧은 DB 트랜잭션에서 호출 소유권만 확보하고 외부 통신은 호출자에게 맡깁니다. */
export class PdfDispatchState {
  /** 기존 문서 큐와 같은 연결 풀·검증된 스키마를 사용합니다. */
  constructor(readonly pool: pg.Pool, readonly schema = process.env.G2B_DB_SCHEMA || "public") {
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("DB 스키마 이름이 올바르지 않습니다.");
  }
  /** 신규 PDF 큐와 실행 요청 세대를 같은 커밋에 묶습니다. */
  async request(db: pg.PoolClient, repository: string): Promise<void> {
    if (normalizeDispatchRepository(repository) !== repository) throw new Error("PDF 실행 저장소를 확인하세요.");
    await db.query(`INSERT INTO ${this.schema}.pdf_dispatch_state(repository,requested_generation) VALUES($1,1)
      ON CONFLICT(repository) DO UPDATE SET requested_generation=${this.schema}.pdf_dispatch_state.requested_generation+1,
        updated_at=clock_timestamp()`, [repository]);
  }
  /** 준비된 PDF가 있을 때만 5분 간격과 60초 임대를 DB 시각으로 검사해 호출권을 확보합니다. */
  async claim(repository: string): Promise<DispatchClaim> {
    if (normalizeDispatchRepository(repository) !== repository) throw new Error("PDF 실행 저장소를 확인하세요.");
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN"); await db.query("SET LOCAL lock_timeout='5s'"); await db.query("SET LOCAL statement_timeout='15s'");
      const row = (await db.query(`SELECT *,requested_generation::text generation,
        requested_generation>acknowledged_generation pending,
        owner_token IS NOT NULL AND lease_expires_at>clock_timestamp() in_flight,
        last_attempt_at IS NOT NULL AND last_attempt_at>clock_timestamp()-interval '5 minutes' cooling
        FROM ${this.schema}.pdf_dispatch_state WHERE repository=$1 FOR UPDATE`, [repository])).rows[0];
      let result: DispatchClaim = { reason: "idle" };
      if (row?.pending) {
        if (row.in_flight) result = { reason: "in_flight" };
        else {
          const work = (await db.query(`WITH pending AS MATERIALIZED (SELECT r.next_attempt_at ${eligibleQueuedPdfSql(this.schema)})
            SELECT EXISTS(SELECT 1 FROM pending WHERE next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) ready,
              EXISTS(SELECT 1 FROM pending WHERE next_attempt_at>clock_timestamp()) delayed`)).rows[0];
          if (!work.ready && work.delayed) result = { reason: "delayed" };
          else if (!work.ready) await db.query(`UPDATE ${this.schema}.pdf_dispatch_state SET acknowledged_generation=requested_generation,
            owner_token=NULL,lease_expires_at=NULL,claimed_generation=NULL,last_outcome='no_ready_work',updated_at=clock_timestamp() WHERE repository=$1`, [repository]);
          else if (row.cooling) result = { reason: "cooldown" };
          else {
            const busy = (await db.query(`SELECT owner_token IS NOT NULL AND expires_at>clock_timestamp() busy
              FROM ${this.schema}.attachment_extraction_worker_lease WHERE id=1`)).rows[0]?.busy;
            if (busy) result = { reason: "worker_busy" };
            else {
              const token = randomUUID();
              await db.query(`UPDATE ${this.schema}.pdf_dispatch_state SET owner_token=$2,claimed_generation=requested_generation,
                lease_expires_at=clock_timestamp()+interval '60 seconds',last_attempt_at=clock_timestamp(),attempt_count=attempt_count+1,
                last_outcome='calling',updated_at=clock_timestamp() WHERE repository=$1`, [repository,token]);
              result = { reason: "claimed", token, generation: row.generation };
            }
          }
        }
      }
      await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK").catch(()=>undefined); throw error; }
    finally { db.release(); }
  }
  /** 자신이 확보한 세대만 확인 완료로 표시하고 새 세대나 만료된 응답의 덮어쓰기를 막습니다. */
  async finish(repository: string, token: string, generation: string, response: DispatchResponse): Promise<boolean> {
    const result = await this.pool.query(`UPDATE ${this.schema}.pdf_dispatch_state
      SET acknowledged_generation=CASE WHEN $4::boolean AND NOT EXISTS(SELECT 1 ${eligibleQueuedPdfSql(this.schema)}
          AND r.next_attempt_at>clock_timestamp()) THEN GREATEST(acknowledged_generation,$3::bigint) ELSE acknowledged_generation END,
        owner_token=NULL,claimed_generation=NULL,lease_expires_at=NULL,last_outcome=$5,last_http_status=$6,
        last_run_url=COALESCE($7,last_run_url),updated_at=clock_timestamp()
      WHERE repository=$1 AND owner_token=$2 AND claimed_generation=$3::bigint AND lease_expires_at>clock_timestamp()`,
    [repository,token,generation,response.accepted,response.reason,response.httpStatus??null,response.runUrl??null]);
    return !!result.rowCount;
  }
}
