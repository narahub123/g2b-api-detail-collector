import {downloadableAttachmentSql} from '../g2b/attachment-sql';
import type { MaintenanceInfo } from "../g2b/maintenance";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pickPdfAttachment } from "./contract";
import {fixedAttachmentExclusionSql} from '../g2b/attachment-exclusions';
import type { PdfResult } from "./contract";
import {sanitizeStoredDiagnostic} from './diagnostics';
import type {DiagnosticError,ExtractionProgress} from './diagnostics';
import { advanceStageTimings, finishStageTimings } from './stage-timings';
import type { StageTiming, StageOutcome } from './stage-timings';
import type { ExtractionPurpose, ReadyCounts } from './priority';
import { discoveryCandidatesSql } from './discovery';

import { EXTRACTOR_VERSION } from "./extractor-version";
export { EXTRACTOR_VERSION } from "./extractor-version";
export type Failure = { code: string; message: string; retry: boolean; status?: "failed" | "interrupted" | "unsupported"; diagnostic?:DiagnosticError };
export type QueueRun = { id: string; document_id: string; chain_id: string; source: string; status: string;
  attempt_number: number; retry_eligible: boolean; finished_at: Date; notice_key: string; file_no: string; seq: number; stage_timings?:StageTiming[];purpose?:ExtractionPurpose };

/** 짧은 트랜잭션으로 작업기 소유권과 문서 단위 배타성을 보장합니다. */
export class DocumentQueue {
  readonly schema: string;
  constructor(readonly pool: pg.Pool, schema = process.env.G2B_DB_SCHEMA || "public") {
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("DB 스키마 이름이 올바르지 않습니다.");
    this.schema = schema;
  }
  /** 풀링 연결에서도 같은 연결에서 커밋·롤백하고 오류 연결을 반환합니다. */
  async transaction<T>(work: (db: pg.PoolClient) => Promise<T>) {
    const db = await this.pool.connect();
    try { await db.query("BEGIN"); await db.query("SET LOCAL lock_timeout='5s'"); await db.query("SET LOCAL statement_timeout='15s'");
      const result = await work(db); await db.query("COMMIT"); return result;
    } catch(error) { await db.query("ROLLBACK").catch(()=>undefined); throw error; } finally { db.release(); }
  }
  /** 모든 상태 변경 전에 임대 행을 먼저 잠그고 현재 토큰·만료를 검사합니다. */
  private async owned(db: pg.PoolClient, token: string) {
    const row = await db.query(`SELECT owner_token=$1 AND expires_at>clock_timestamp() valid FROM ${this.schema}.attachment_extraction_worker_lease WHERE id=1 FOR UPDATE`,[token]);
    if (!row.rows[0]?.valid) throw new Error("PDF 작업기 임대 소유권을 잃었습니다.");
  }
  /** 임대 TTL이 지나기 전에도 경쟁 작업기가 토큰을 교체할 수 없게 조건부 선점합니다. */
  async acquire(token: string) {
    const r=await this.pool.query({text:`UPDATE ${this.schema}.attachment_extraction_worker_lease SET owner_token=$1,expires_at=clock_timestamp()+interval '120 seconds',updated_at=now()
      WHERE id=1 AND (owner_token IS NULL OR expires_at<=clock_timestamp()) RETURNING id`,values:[token]}); return !!r.rowCount;
  }
  /** 만료된 토큰은 갱신하지 않아 오래 멈춘 작업기의 재진입을 막습니다. */
  async renew(token: string) {
    const r=await this.pool.query({text:`UPDATE ${this.schema}.attachment_extraction_worker_lease SET expires_at=clock_timestamp()+interval '120 seconds',updated_at=now()
      WHERE id=1 AND owner_token=$1 AND expires_at>clock_timestamp() RETURNING id`,values:[token]}); return !!r.rowCount;
  }
  /** 다른 소유자가 획득한 임대를 해제하지 않습니다. */
  async release(token: string) {
    await this.pool.query({text:`UPDATE ${this.schema}.attachment_extraction_worker_lease SET owner_token=NULL,expires_at=NULL,updated_at=now() WHERE id=1 AND owner_token=$1`,values:[token]});
  }
  /** 독립 접수의 트랜잭션을 열고 공통 등록 로직으로 활성 요청을 통합합니다. */
  async enqueue(key: string, fileNo: string, seq: number, source: "manual" | "automatic") {
    return this.transaction(db => this.enqueueInTransaction(db, key, fileNo, seq, source));
  }
  /** 호출자의 연결에서 직접 첨부를 검증하고 문서 잠금으로 동시 등록을 직렬화합니다.
   * @remarks 커밋은 호출자가 수행하며 PDF 작업기 임대는 획득하지 않습니다.
   */
  async enqueueInTransaction(db: pg.PoolClient, key: string, fileNo: string, seq: number, source: "manual" | "automatic") {
    return (await this.enqueueManyInTransaction(db, key, [{ fileNo, seq }], source))[0];
  }
  /** 공고별 첨부를 한 번 검증하고 묶음 SQL로 등록하여 상세 잠금의 DB 왕복 시간을 줄입니다.
   * @remarks 문서 식별자 순서로 잠그며 기존 단건 접수와 같은 활성 요청·버전 이력 정책을 사용합니다.
   */
  async enqueueManyInTransaction(db: pg.PoolClient, key: string, identities: { fileNo: string; seq: number }[], source: "manual" | "automatic") {
    if (!identities.length) return [];
    // 신규 문서의 외래 키 검사보다 먼저 공고 잠금을 확보하여 상세 저장과의 역순 대기를 막습니다.
    const n = (await db.query(`SELECT detail FROM ${this.schema}.notices WHERE key=$1 FOR KEY SHARE`, [key])).rows[0];
    const raw = n?.detail?.attachments;
    const files = Array.isArray(raw) ? raw.filter(file => file && typeof file.name === "string") : [];
    const unique = new Map<string, ReturnType<typeof pickPdfAttachment>>();
    for (const identity of identities) {
      const file = pickPdfAttachment(key, identity.fileNo, identity.seq, files);
      unique.set(`${file.fileNo.toLowerCase()}:${file.seq}`, file);
    }
    const values = [...unique.values()].map(file => ({ file_no: file.fileNo.toLowerCase(), seq: file.seq,
      filename: file.name, attachment_url: file.url }));
    // 모든 접수 경로가 같은 순서로 문서를 확보해야 묶음 등록과 단건 접수가 교착하지 않습니다.
    const docs = (await db.query(`INSERT INTO ${this.schema}.attachment_documents(notice_key,file_no,seq,filename,attachment_url,document_type)
      SELECT $1,a.file_no::uuid,a.seq,a.filename,a.attachment_url,'pdf'
      FROM jsonb_to_recordset($2::jsonb) AS a(file_no text,seq int,filename text,attachment_url text)
      ORDER BY a.file_no,a.seq
      ON CONFLICT(notice_key,file_no,seq) DO UPDATE SET filename=EXCLUDED.filename,attachment_url=EXCLUDED.attachment_url,
        document_type='pdf',is_current=true,updated_at=now() RETURNING id`, [key, JSON.stringify(values)])).rows;
    const states = (await db.query(`SELECT d.id,d.filename,d.attachment_url,to_jsonb(active) active,to_jsonb(done) done,
      EXISTS(SELECT 1 FROM ${this.schema}.attachment_extraction_runs r WHERE r.document_id=d.id) has_history
      FROM ${this.schema}.attachment_documents d
      LEFT JOIN LATERAL (SELECT r.* FROM ${this.schema}.attachment_extraction_runs r
        WHERE r.document_id=d.id AND r.status IN ('queued','processing') LIMIT 1) active ON true
      LEFT JOIN LATERAL (SELECT r.* FROM ${this.schema}.attachment_extraction_runs r
        WHERE r.document_id=d.id AND r.extractor_version=$2 ORDER BY r.requested_at DESC,r.id DESC LIMIT 1) done ON true
      WHERE d.id=ANY($1::uuid[]) ORDER BY d.file_no,d.seq`, [docs.map(doc => doc.id), EXTRACTOR_VERSION])).rows;
    const promoted = states.filter(row => source === "manual" && row.active?.status === "queued" && row.active.source === "automatic");
    if (promoted.length) {
      await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET source='manual' WHERE chain_id=ANY($1::uuid[])`,
        [promoted.map(row => row.active.chain_id)]);
      for (const row of promoted) row.active.source = "manual";
    }
    const pending = states.filter(row => !row.active && !(source === "automatic" && row.done)).map(row => ({
      run_id: randomUUID(), document_id: row.id, filename: row.filename, attachment_url: row.attachment_url,
      purpose: row.has_history ? "reextract" : "initial",
    }));
    const inserted: QueueRun[] = pending.length ? (await db.query(`INSERT INTO ${this.schema}.attachment_extraction_runs
      (id,document_id,chain_id,source,status,filename,attachment_url,extractor_version,document_type,purpose)
      SELECT a.run_id,a.document_id,a.run_id,$2,'queued',a.filename,a.attachment_url,$3,'pdf',a.purpose
      FROM jsonb_to_recordset($1::jsonb) AS a(run_id uuid,document_id uuid,filename text,attachment_url text,purpose text)
      RETURNING *`, [JSON.stringify(pending), source, EXTRACTOR_VERSION])).rows : [];
    if (pending.length) await db.query(`UPDATE ${this.schema}.attachment_documents d
      SET active_chain_id=a.run_id,latest_run_id=a.run_id,current_run_id=a.run_id,updated_at=now()
      FROM jsonb_to_recordset($1::jsonb) AS a(run_id uuid,document_id uuid) WHERE d.id=a.document_id`, [JSON.stringify(pending)]);
    return states.map(row => {
      const reused = row.active ?? (source === "automatic" ? row.done : null);
      // JSON으로 함께 조회한 기존 실행도 단건 접수와 같은 pg 날짜 표현을 유지합니다.
      if (reused) for (const field of ["requested_at", "started_at", "finished_at", "next_attempt_at", "stage_started_at", "last_progress_at"]) {
        if (typeof reused[field] === "string") reused[field] = new Date(reused[field]);
      }
      return { ...(reused ?? inserted.find(run => run.document_id === row.id)), reused: !!reused } as QueueRun & { reused: boolean };
    });
  }
  /** 신규 PDF부터 최대 20건만 접수하고 파일 처리 사이에 상위 요청을 다시 확인할 수 있게 합니다. */
  async discover(noticeKey?: string, stop:()=>boolean=()=>false) {
    if(stop())return 0;
    const sql=discoveryCandidatesSql(this.schema),parameters=[noticeKey??null,EXTRACTOR_VERSION];
    // 묶음 등록·만료 복구와 같은 순서로 잠근 뒤 이름 변경과 사라진 첨부 상태를 반영합니다.
    await this.pool.query(`${sql}, checked AS MATERIALIZED (
      SELECT d.id,a.filename,a.attachment_url,(a.key IS NOT NULL OR EXISTS(
       SELECT 1 FROM ${this.schema}.notices n CROSS JOIN LATERAL
        jsonb_array_elements(CASE WHEN jsonb_typeof(n.detail->'attachments')='array' THEN n.detail->'attachments' ELSE '[]'::jsonb END) raw
       WHERE n.key=d.notice_key AND (raw->>'url'=d.attachment_url OR
        (lower(raw->>'fileNo')=d.file_no::text AND raw->>'seq'=d.seq::text)))) AS present
      FROM ${this.schema}.attachment_documents d LEFT JOIN attachments a
       ON a.key=d.notice_key AND a.file_no::uuid=d.file_no AND a.seq=d.seq
      WHERE ($1::text IS NULL OR d.notice_key=$1)
    ), locked AS MATERIALIZED (
      SELECT d.id FROM ${this.schema}.attachment_documents d JOIN checked c ON c.id=d.id
      WHERE (d.filename,d.attachment_url,d.is_current)
        IS DISTINCT FROM (COALESCE(c.filename,d.filename),COALESCE(c.attachment_url,d.attachment_url),c.present)
      ORDER BY d.notice_key,d.file_no,d.seq FOR UPDATE OF d
    ) UPDATE ${this.schema}.attachment_documents d SET filename=COALESCE(c.filename,d.filename),
      attachment_url=COALESCE(c.attachment_url,d.attachment_url),is_current=c.present,updated_at=now()
     FROM checked c JOIN locked l ON l.id=c.id WHERE c.id=d.id AND (d.filename,d.attachment_url,d.is_current)
      IS DISTINCT FROM (COALESCE(c.filename,d.filename),COALESCE(c.attachment_url,d.attachment_url),c.present)`,parameters);
    if(stop())return 0;
    const rows=(await this.pool.query(`${sql} SELECT key,file_no,seq,attachment_url FROM candidates ORDER BY has_history,key,seq,file_no LIMIT 20`,parameters)).rows;
    let found=0;
    for(const row of rows){
      if(stop())break;
      const run=await this.enqueue(row.key,row.file_no,row.seq,'automatic');
      if(!run.reused)found++;
    }
    return found;
  }
  /** 잠금 순서를 임대→문서→실행으로 고정하고 실행 소유권도 검사합니다. */
  private async processing(db: pg.PoolClient, token: string, id: string) {
    await this.owned(db,token);
    const doc=(await db.query(`SELECT d.* FROM ${this.schema}.attachment_documents d JOIN ${this.schema}.attachment_extraction_runs r ON r.document_id=d.id WHERE r.id=$1 FOR UPDATE OF d`,[id])).rows[0];
    const run=(await db.query(`SELECT * FROM ${this.schema}.attachment_extraction_runs WHERE id=$1 FOR UPDATE`,[id])).rows[0];
    if(!run || run.status!=="processing" || run.owner_token!==token || doc.active_chain_id!==run.chain_id || doc.current_run_id!==id) throw new Error("PDF 실행 소유권이 올바르지 않습니다.");
    return {doc,run:run as QueueRun};
  }
  /** 마지막 단계는 DB 종료 시각으로 마감하고 강제 중단은 마지막 관측 시각까지만 추정합니다. */
  private async finishTimings(db:pg.PoolClient,id:string,outcome:StageOutcome,estimated=false){
    const row=(await db.query(`SELECT stage_timings,last_progress_at,clock_timestamp() AS at FROM ${this.schema}.attachment_extraction_runs WHERE id=$1`,[id])).rows[0];
    if(!row)return;
    const at=estimated?row.last_progress_at:row.at;
    if(!at)return;
    const timings=finishStageTimings(row.stage_timings??[],new Date(at).toISOString(),outcome,estimated);
    await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET stage_timings=$2::jsonb WHERE id=$1`,[id,JSON.stringify(timings)]);
  }
  /** 수동·자동 신규·자동 재추출 순서로 선점하고 실제 사용할 추출기 버전을 기록합니다. */
  async claim(token: string, manualOnly=false, noticeKey?: string): Promise<QueueRun | null> {
    return this.transaction(async db=>{
      await this.owned(db,token);
      const doc=(await db.query(`SELECT d.* FROM ${this.schema}.attachment_documents d JOIN ${this.schema}.attachment_extraction_runs r ON r.id=d.current_run_id
        WHERE r.status='queued' AND r.chain_id=d.active_chain_id AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=clock_timestamp())
        AND (NOT $1::boolean OR r.source='manual') AND ($2::text IS NULL OR d.notice_key=$2)
        AND ${downloadableAttachmentSql('d.attachment_url')}
        AND ${fixedAttachmentExclusionSql('d.file_no::text','d.seq')}
        ORDER BY CASE WHEN r.source='manual' THEN 0 WHEN r.purpose='initial' THEN 1 ELSE 2 END,r.requested_at,r.id LIMIT 1 FOR UPDATE OF d`,[manualOnly,noticeKey??null])).rows[0];
      if(!doc)return null;
      const r=(await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status='processing',owner_token=$2,extractor_version=$3,started_at=clock_timestamp(),error=NULL,error_code=NULL,diagnostic_error=NULL WHERE id=$1 AND status='queued' RETURNING *`,[doc.current_run_id,token,EXTRACTOR_VERSION])).rows[0];
      await this.owned(db,token);
      return {...r,notice_key:doc.notice_key,file_no:doc.file_no,seq:doc.seq};
    });
  }
  /** 본문·완료 상태·성공 포인터를 같은 트랜잭션으로 반영합니다. */
  async complete(token:string,id:string,result:PdfResult,peakMemory:number|null) {
    await this.transaction(async db=>{
      const {doc}=await this.processing(db,token,id);
      const status=result.characterCount?"completed":"no_text";
      if(status==='completed')await db.query(`INSERT INTO ${this.schema}.attachment_document_contents(document_id,run_id,pages)
        VALUES($1,$2,$3::jsonb) ON CONFLICT(document_id) DO UPDATE SET run_id=EXCLUDED.run_id,pages=EXCLUDED.pages,updated_at=clock_timestamp()`,[doc.id,id,JSON.stringify(result.pages)]);
      await this.finishTimings(db,id,'completed');
      await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status=$2,page_count=$3,character_count=$4,extractor_version=$5,file_hash=$6,peak_memory_bytes=$7,
        finished_at=clock_timestamp(),elapsed_ms=COALESCE(elapsed_ms,0)+extract(epoch FROM(clock_timestamp()-started_at))*1000 WHERE id=$1`,[id,status,result.pageCount,result.characterCount,result.extractorVersion,result.fileHash,peakMemory]);
      await db.query(`UPDATE ${this.schema}.attachment_documents SET current_run_id=NULL,last_success_run_id=CASE WHEN $3='completed' THEN $2::uuid ELSE last_success_run_id END,updated_at=now() WHERE id=$1`,[doc.id,id,status]);
      await this.owned(db,token);
    });
  }
  /** 현재 실행 소유권과 진행 시각을 확인해 지연된 메시지의 덮어쓰기를 막습니다. */
  async progress(token:string,id:string,value:ExtractionProgress){
    await this.transaction(async db=>{
      const {run}=await this.processing(db,token,id);
      const previous=run.stage_timings?.at(-1);
      if(previous&&Date.parse(value.at)<Date.parse(previous.endedAt??previous.startedAt))return;
      await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET
        stage_started_at=CASE WHEN stage IS DISTINCT FROM $3 THEN $4::timestamptz ELSE stage_started_at END,
        stage=$3,last_progress_at=$4,current_page=COALESCE($5,current_page),completed_pages=COALESCE($6,completed_pages),total_pages=COALESCE($7,total_pages),stage_timings=$8::jsonb
        WHERE id=$1 AND owner_token=$2 AND status='processing' AND (last_progress_at IS NULL OR last_progress_at<=$4::timestamptz)`,
        [id,token,value.stage,value.at,value.currentPage??null,value.completedPages??null,value.totalPages??null,JSON.stringify(advanceStageTimings(run.stage_timings??[],value))]);
    });
  }
  /** 결과 저장 실패는 추출 실패로 바꾸지 않고 복구할 실행에 기술 정보만 남깁니다. */
  async recordDiagnostic(token:string,id:string,error:DiagnosticError){
    await this.transaction(async db=>{
      await this.processing(db,token,id);
      await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET diagnostic_error=$2::jsonb WHERE id=$1`,[id,JSON.stringify(sanitizeStoredDiagnostic(error))]);
    });
  }
  /** 실행 여유 부족이나 점검으로 미완료 요청을 같은 시도 번호로 대기에 돌려놓습니다. */
  async deferClaim(token:string,id:string,maintenance?:MaintenanceInfo){
    await this.transaction(async db=>{
      await this.processing(db,token,id);
      await this.finishTimings(db,id,'deferred');
      await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status='queued',owner_token=NULL,elapsed_ms=COALESCE(elapsed_ms,0)+extract(epoch FROM(clock_timestamp()-started_at))*1000,started_at=NULL,stage=NULL,stage_started_at=NULL,last_progress_at=NULL,current_page=NULL,completed_pages=NULL,total_pages=NULL,error_code=$2,error=$3,diagnostic_error=NULL WHERE id=$1`,[id,maintenance?.code??null,maintenance?.message??null]);
      await this.owned(db,token);
    });
  }
  /** 종료 기록을 보존하면서 부모당 한 개의 지연 재시도만 생성합니다. 문서 잠금 안에서만 호출합니다. */
  private async retry(db:pg.PoolClient,run:QueueRun) {
    if(!run.retry_eligible || run.attempt_number>=3) return null;
    const id=randomUUID();
    const inserted=(await db.query(`INSERT INTO ${this.schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,retry_of,attempt_number,filename,attachment_url,extractor_version,next_attempt_at,document_type,purpose)
      SELECT $2,document_id,chain_id,source,'queued',id,attempt_number+1,filename,attachment_url,extractor_version,
        finished_at+CASE WHEN attempt_number=1 THEN interval '1 minute' ELSE interval '5 minutes' END,document_type,purpose
      FROM ${this.schema}.attachment_extraction_runs WHERE id=$1
      ON CONFLICT(retry_of) WHERE retry_of IS NOT NULL DO NOTHING RETURNING id`,[run.id,id])).rows[0];
    const child=inserted ?? (await db.query(`SELECT id FROM ${this.schema}.attachment_extraction_runs WHERE retry_of=$1`,[run.id])).rows[0];
    if(child) await db.query(`UPDATE ${this.schema}.attachment_documents SET current_run_id=$2,latest_run_id=$2,updated_at=now() WHERE id=$1`,[run.document_id,child.id]);
    return child?.id ?? null;
  }
  /** 실패 상태와 다음 시도·현재 포인터를 함께 커밋하며 저장 실패는 만료 복구에 맡깁니다. */
  async fail(token:string,id:string,failure:Failure) {
    await this.transaction(async db=>{
      const {doc,run}=await this.processing(db,token,id);
      await this.finishTimings(db,id,failure.status==='interrupted'?'interrupted':'failed');
      await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status=$2,error_code=$3,error=$4,retry_eligible=$5,diagnostic_error=$6::jsonb,finished_at=clock_timestamp(),elapsed_ms=COALESCE(elapsed_ms,0)+extract(epoch FROM(clock_timestamp()-started_at))*1000 WHERE id=$1`,[id,failure.status??"failed",failure.code,failure.message.slice(0,1000),failure.retry,failure.diagnostic?JSON.stringify(sanitizeStoredDiagnostic(failure.diagnostic)):null]);
      await db.query(`UPDATE ${this.schema}.attachment_documents SET current_run_id=NULL,updated_at=now() WHERE id=$1`,[doc.id]);
      await this.retry(db,{...run,retry_eligible:failure.retry});
      await this.owned(db,token);
    });
  }
  /** 묶음 등록과 같은 공고·첨부 순서로 잠그고 새 소유자만 만료 실행을 복구합니다. */
  async recover(token:string) {
    return this.transaction(async db=>{
      await this.owned(db,token);
      const docs=(await db.query(`SELECT d.* FROM ${this.schema}.attachment_documents d WHERE EXISTS(
        SELECT 1 FROM ${this.schema}.attachment_extraction_runs r WHERE r.document_id=d.id AND r.chain_id=d.active_chain_id
        AND (r.status='processing' OR (r.status IN ('failed','interrupted') AND r.retry_eligible AND r.attempt_number<3
          AND NOT EXISTS(SELECT 1 FROM ${this.schema}.attachment_extraction_runs c WHERE c.retry_of=r.id))))
        ORDER BY d.notice_key,d.file_no,d.seq FOR UPDATE OF d`)).rows;
      let recovered=0,exhausted=0;
      for(const doc of docs) {
        const run=(await db.query(`SELECT * FROM ${this.schema}.attachment_extraction_runs WHERE document_id=$1 AND chain_id=$2 ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,[doc.id,doc.active_chain_id])).rows[0] as QueueRun;
        if(run.status==='processing') {
          const owner=(await db.query(`SELECT owner_token FROM ${this.schema}.attachment_extraction_runs WHERE id=$1`,[run.id])).rows[0].owner_token;
          if(owner===token) continue;
          await this.finishTimings(db,run.id,'interrupted',true);
          await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status='interrupted',retry_eligible=true,error_code='worker_interrupted',error='이전 작업기의 임대가 만료되었습니다.',finished_at=clock_timestamp(),elapsed_ms=COALESCE(elapsed_ms,0)+extract(epoch FROM(clock_timestamp()-started_at))*1000 WHERE id=$1`,[run.id]);
          run.retry_eligible=true; recovered++;
          await db.query(`UPDATE ${this.schema}.attachment_documents SET current_run_id=NULL,updated_at=now() WHERE id=$1`,[doc.id]);
        }
        if(run.retry_eligible && ['processing','failed','interrupted'].includes(run.status)) {
          if(run.attempt_number>=3) exhausted++;
          else if(!(await db.query(`SELECT 1 FROM ${this.schema}.attachment_extraction_runs WHERE document_id=$1 AND status IN ('queued','processing')`,[doc.id])).rowCount) {
            await this.retry(db,run); if(run.status!=='processing') recovered++;
          }
        }
      }
      await this.owned(db,token);return {checked:docs.length,recovered,exhausted};
    });
  }
  /** 본문을 읽지 않고 현재 실행 가능한 요청 수만 집계합니다. */
  async readyCount(manualOnly=false,noticeKey?:string) {
    const counts=await this.readyCounts(manualOnly,noticeKey);
    return counts.manual+counts.initial+counts.reextract;
  }
  /** 준비된 현재 체인만 종류별로 집계해 우선순위별 대기량을 보고합니다. */
  async readyCounts(manualOnly=false,noticeKey?:string):Promise<ReadyCounts>{
    const rows=(await this.pool.query(`SELECT CASE WHEN r.source='manual' THEN 'manual' WHEN r.purpose='initial' THEN 'initial' ELSE 'reextract' END AS kind,count(*)::int AS n
      FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.current_run_id=r.id AND d.active_chain_id=r.chain_id
      WHERE r.status='queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=clock_timestamp())
       AND ${downloadableAttachmentSql('d.attachment_url')}
       AND ${fixedAttachmentExclusionSql('d.file_no::text','d.seq')}
       AND (NOT $1::boolean OR r.source='manual') AND ($2::text IS NULL OR d.notice_key=$2) GROUP BY 1`,[manualOnly,noticeKey??null])).rows;
    const counts:ReadyCounts={manual:0,initial:0,reextract:0};
    for(const row of rows)counts[row.kind as keyof ReadyCounts]=Number(row.n);
    return counts;
  }
  /** 자식 프로세스에서도 실행·문서·임대의 소속을 다시 확인합니다. */
  async executionFile(id:string,token:string,key:string) {
    const r=(await this.pool.query(`SELECT d.notice_key,d.file_no,d.seq,n.detail FROM ${this.schema}.attachment_extraction_runs r
      JOIN ${this.schema}.attachment_documents d ON d.id=r.document_id JOIN ${this.schema}.notices n ON n.key=d.notice_key
      JOIN ${this.schema}.attachment_extraction_worker_lease l ON l.id=1
      WHERE r.id=$1 AND r.status='processing' AND r.owner_token=$2 AND l.owner_token=$2 AND l.expires_at>clock_timestamp()
      AND d.notice_key=$3 AND d.current_run_id=r.id AND d.active_chain_id=r.chain_id`,[id,token,key])).rows[0];
    if(!r)throw new Error("PDF 실행 소유권이 올바르지 않습니다.");
    return pickPdfAttachment(key,r.file_no,r.seq,r.detail?.attachments??[]);
  }
}
