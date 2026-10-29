import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pickPdfAttachment } from "./contract";
import type { PdfResult } from "./contract";
import { parseAttachmentDownloadUrl } from "../g2b/attachment-links";

export const EXTRACTOR_VERSION = "6.4.299 / reading-order-v1";
export type Failure = { code: string; message: string; retry: boolean; status?: "failed" | "interrupted" | "unsupported" };
export type QueueRun = { id: string; document_id: string; chain_id: string; source: string; status: string;
  attempt_number: number; retry_eligible: boolean; finished_at: Date; notice_key: string; file_no: string; seq: number };

/** 짧은 트랜잭션으로 작업기 소유권과 문서 단위 배타성을 보장합니다. */
export class DocumentQueue {
  readonly schema: string;
  constructor(readonly pool: pg.Pool, schema = process.env.G2B_DB_SCHEMA || "public") {
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("DB 스키마 이름이 올바르지 않습니다.");
    this.schema = schema;
  }
  /** 풀링 연결에서도 같은 연결에서 커밋·롤백하고 오류 연결을 반환합니다. */
  private async transaction<T>(work: (db: pg.PoolClient) => Promise<T>) {
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
  /** 원본 직접 첨부를 검증하고 같은 파일의 활성 요청을 통합합니다. */
  async enqueue(key: string, fileNo: string, seq: number, source: "manual" | "automatic") {
    return this.transaction(async db=>{
      const n=await db.query(`SELECT detail FROM ${this.schema}.notices WHERE key=$1`,[key]);
      const file=pickPdfAttachment(key,fileNo,seq,n.rows[0]?.detail?.attachments ?? []);
      const d=(await db.query(`INSERT INTO ${this.schema}.attachment_documents(notice_key,file_no,seq,filename,attachment_url)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(notice_key,file_no,seq) DO UPDATE SET filename=EXCLUDED.filename,attachment_url=EXCLUDED.attachment_url,is_current=true,updated_at=now() RETURNING *`,[key,fileNo,seq,file.name,file.url])).rows[0];
      const active=(await db.query(`SELECT * FROM ${this.schema}.attachment_extraction_runs WHERE document_id=$1 AND status IN ('queued','processing')`,[d.id])).rows[0];
      if(active) {
        if(source==='manual' && active.status==='queued' && active.source==='automatic') {
          await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET source='manual' WHERE chain_id=$1`,[active.chain_id]); active.source='manual';
        }
        return {...active,reused:true} as QueueRun & {reused:boolean};
      }
      if(source==='automatic') {
        const done=(await db.query(`SELECT * FROM ${this.schema}.attachment_extraction_runs WHERE document_id=$1 AND extractor_version=$2 ORDER BY requested_at DESC,id DESC LIMIT 1`,[d.id,EXTRACTOR_VERSION])).rows[0];
        if(done) return {...done,reused:true} as QueueRun & {reused:boolean};
      }
      const id=randomUUID();
      const r=(await db.query(`INSERT INTO ${this.schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,extractor_version)
        VALUES($1,$2,$1,$3,'queued',$4,$5,$6) RETURNING *`,[id,d.id,source,file.name,file.url,EXTRACTOR_VERSION])).rows[0];
      await db.query(`UPDATE ${this.schema}.attachment_documents SET active_chain_id=$2,latest_run_id=$2,current_run_id=$2,updated_at=now() WHERE id=$1`,[d.id,id]);
      return {...r,reused:false} as QueueRun & {reused:boolean};
    });
  }
  /** 직접 첨부만 작은 묶음으로 발견하고 사라진 첨부는 이력을 유지한 채 제외합니다. */
  async discover(noticeKey?: string, stop:()=>boolean=()=>false) {
    let after="", found=0;
    while(true) {
      if(stop())break;
      const rows=(await this.pool.query(`SELECT key,detail->'attachments' attachments FROM ${this.schema}.notices WHERE key>$1 AND ($2::text IS NULL OR key=$2) ORDER BY key LIMIT 100`,[after,noticeKey ?? null])).rows;
      if(!rows.length) break;
      for(const row of rows) {
        if(stop())return found;
        const current: string[]=[];
        for(const file of Array.isArray(row.attachments)?row.attachments:[]) {
          if(stop())return found;
          if(typeof file?.url!=="string" || typeof file.name!=="string" || !/\.pdf$/i.test(file.name.trim())) continue;
          const identity=parseAttachmentDownloadUrl(file.url);
          if(!identity || identity.key!==row.key || identity.modalIndex!==undefined) continue;
          current.push(file.url); await this.enqueue(identity.key,identity.fileNo,identity.seq,"automatic");found++;
        }
        await this.pool.query(`UPDATE ${this.schema}.attachment_documents SET is_current=false,updated_at=now() WHERE notice_key=$1 AND NOT(attachment_url=ANY($2::text[])) AND is_current`,[row.key,current]);
      }
      after=rows.at(-1).key;
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
  /** 준비된 수동 요청을 먼저 선점하며 실행 중 파일은 건드리지 않습니다. */
  async claim(token: string, manualOnly=false, noticeKey?: string): Promise<QueueRun | null> {
    return this.transaction(async db=>{
      await this.owned(db,token);
      const doc=(await db.query(`SELECT d.* FROM ${this.schema}.attachment_documents d JOIN ${this.schema}.attachment_extraction_runs r ON r.id=d.current_run_id
        WHERE r.status='queued' AND r.chain_id=d.active_chain_id AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=clock_timestamp())
        AND (NOT $1::boolean OR r.source='manual') AND ($2::text IS NULL OR d.notice_key=$2)
        ORDER BY (r.source='manual') DESC,r.requested_at,r.id LIMIT 1 FOR UPDATE OF d`,[manualOnly,noticeKey??null])).rows[0];
      if(!doc)return null;
      const r=(await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status='processing',owner_token=$2,started_at=clock_timestamp() WHERE id=$1 AND status='queued' RETURNING *`,[doc.current_run_id,token])).rows[0];
      await this.owned(db,token);
      return {...r,notice_key:doc.notice_key,file_no:doc.file_no,seq:doc.seq};
    });
  }
  /** 본문·완료 상태·성공 포인터를 같은 트랜잭션으로 반영합니다. */
  async complete(token:string,id:string,result:PdfResult,peakMemory:number|null) {
    await this.transaction(async db=>{
      const {doc}=await this.processing(db,token,id);
      const status=result.characterCount?"completed":"no_text";
      await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status=$2,pages=$3::jsonb,page_count=$4,character_count=$5,extractor_version=$6,file_hash=$7,peak_memory_bytes=$8,
        finished_at=clock_timestamp(),elapsed_ms=extract(epoch FROM(clock_timestamp()-started_at))*1000 WHERE id=$1`,[id,status,JSON.stringify(result.pages),result.pageCount,result.characterCount,result.extractorVersion,result.fileHash,peakMemory]);
      await db.query(`UPDATE ${this.schema}.attachment_documents SET current_run_id=NULL,last_success_run_id=CASE WHEN $3='completed' THEN $2::uuid ELSE last_success_run_id END,updated_at=now() WHERE id=$1`,[doc.id,id,status]);
      await this.owned(db,token);
    });
  }
  /** 선점 대기로 예산이 줄면 추출하지 않은 요청을 같은 시도 번호로 대기에 돌려놓습니다. */
  async deferClaim(token:string,id:string){
    await this.transaction(async db=>{
      await this.processing(db,token,id);
      await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status='queued',owner_token=NULL,started_at=NULL WHERE id=$1`,[id]);
      await this.owned(db,token);
    });
  }
  /** 종료 기록을 보존하면서 부모당 한 개의 지연 재시도만 생성합니다. 문서 잠금 안에서만 호출합니다. */
  private async retry(db:pg.PoolClient,run:QueueRun) {
    if(!run.retry_eligible || run.attempt_number>=3) return null;
    const id=randomUUID();
    const inserted=(await db.query(`INSERT INTO ${this.schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,retry_of,attempt_number,filename,attachment_url,extractor_version,next_attempt_at)
      SELECT $2,document_id,chain_id,source,'queued',id,attempt_number+1,filename,attachment_url,extractor_version,
        finished_at+CASE WHEN attempt_number=1 THEN interval '1 minute' ELSE interval '5 minutes' END
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
      await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status=$2,error_code=$3,error=$4,retry_eligible=$5,finished_at=clock_timestamp(),elapsed_ms=extract(epoch FROM(clock_timestamp()-started_at))*1000 WHERE id=$1`,[id,failure.status??"failed",failure.code,failure.message.slice(0,1000),failure.retry]);
      await db.query(`UPDATE ${this.schema}.attachment_documents SET current_run_id=NULL,updated_at=now() WHERE id=$1`,[doc.id]);
      await this.retry(db,{...run,retry_eligible:failure.retry});
      await this.owned(db,token);
    });
  }
  /** 새 소유자만 만료된 처리와 누락된 재시도를 복구합니다. */
  async recover(token:string) {
    return this.transaction(async db=>{
      await this.owned(db,token);
      const docs=(await db.query(`SELECT d.* FROM ${this.schema}.attachment_documents d WHERE EXISTS(
        SELECT 1 FROM ${this.schema}.attachment_extraction_runs r WHERE r.document_id=d.id AND r.chain_id=d.active_chain_id
        AND (r.status='processing' OR (r.status IN ('failed','interrupted') AND r.retry_eligible AND r.attempt_number<3
          AND NOT EXISTS(SELECT 1 FROM ${this.schema}.attachment_extraction_runs c WHERE c.retry_of=r.id)))) ORDER BY d.id FOR UPDATE OF d`)).rows;
      let recovered=0,exhausted=0;
      for(const doc of docs) {
        const run=(await db.query(`SELECT * FROM ${this.schema}.attachment_extraction_runs WHERE document_id=$1 AND chain_id=$2 ORDER BY attempt_number DESC LIMIT 1 FOR UPDATE`,[doc.id,doc.active_chain_id])).rows[0] as QueueRun;
        if(run.status==='processing') {
          const owner=(await db.query(`SELECT owner_token FROM ${this.schema}.attachment_extraction_runs WHERE id=$1`,[run.id])).rows[0].owner_token;
          if(owner===token) continue;
          await db.query(`UPDATE ${this.schema}.attachment_extraction_runs SET status='interrupted',retry_eligible=true,error_code='worker_interrupted',error='이전 작업기의 임대가 만료되었습니다.',finished_at=clock_timestamp(),elapsed_ms=extract(epoch FROM(clock_timestamp()-started_at))*1000 WHERE id=$1`,[run.id]);
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
    return Number((await this.pool.query(`SELECT count(*) n FROM ${this.schema}.attachment_extraction_runs r JOIN ${this.schema}.attachment_documents d ON d.current_run_id=r.id
      WHERE r.status='queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=clock_timestamp()) AND (NOT $1::boolean OR r.source='manual') AND ($2::text IS NULL OR d.notice_key=$2)`,[manualOnly,noticeKey??null])).rows[0].n);
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
