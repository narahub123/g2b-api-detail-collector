import type pg from "pg";
import { pickPdfAttachment } from "./contract";
import { registrationAttachments } from "./registration";

type DocumentIdentity = { notice_key: string; file_no: string; seq: number; is_current: boolean; attachment_revision: number | string };
type RunVersion = { attachment_url: string; attachment_revision: number | string; invalidated_at?: unknown };
export const attachmentObsoleteMessage = "첨부가 변경·삭제되거나 추출 대상에서 제외되어 이전 요청을 중단했습니다.";

/** 최신 상세의 유효한 직접 첨부가 실행 당시의 주소와 버전에 일치하는지 확인합니다. */
export function isCurrentAttachmentRun(doc: DocumentIdentity, run: RunVersion, detail: { attachments?: unknown } | null | undefined): boolean {
  if (!doc.is_current || run.invalidated_at || String(doc.attachment_revision) !== String(run.attachment_revision)) return false;
  const identity = registrationAttachments(doc.notice_key, detail?.attachments)
    .find(file => file.fileNo.toLowerCase() === doc.file_no.toLowerCase() && file.seq === doc.seq);
  if (!identity) return false;
  try { return pickPdfAttachment(doc.notice_key, identity.fileNo, identity.seq, detail!.attachments as Parameters<typeof pickPdfAttachment>[3]).url === run.attachment_url; }
  catch { return false; }
}

/** 공고 잠금 아래 최신 첨부를 문서에 반영하고 구버전 대기는 종료하되 처리 중 소유권은 보존합니다. */
export async function synchronizeNoticeAttachments(db: pg.PoolClient, schema: string, key: string, detail: { attachments?: unknown } | null | undefined) {
  const raw = Array.isArray(detail?.attachments) ? detail.attachments : [];
  const current = registrationAttachments(key, raw).map(identity => pickPdfAttachment(key, identity.fileNo, identity.seq, raw));
  const docs = (await db.query(`SELECT * FROM ${schema}.attachment_documents WHERE notice_key=$1 ORDER BY file_no,seq FOR UPDATE`, [key])).rows;
  if (!docs.length) return;
  const changes = docs.map(doc => {
    const file = current.find(file => file.fileNo.toLowerCase() === doc.file_no && file.seq === doc.seq);
    const exists = raw.some(file => file && typeof file.fileNo === "string" && file.fileNo.toLowerCase() === doc.file_no && file.seq === doc.seq);
    return { id: doc.id, filename: file?.name ?? doc.filename, attachment_url: file?.url ?? doc.attachment_url,
      is_current: !!file, reason: file ? "attachment_changed" : exists ? "attachment_excluded" : "attachment_removed" };
  });
  await db.query(`UPDATE ${schema}.attachment_documents d SET filename=a.filename,attachment_url=a.attachment_url,is_current=a.is_current,
    attachment_revision=d.attachment_revision+CASE WHEN a.is_current AND d.attachment_url<>a.attachment_url THEN 1 ELSE 0 END,updated_at=clock_timestamp()
    FROM jsonb_to_recordset($1::jsonb) a(id uuid,filename text,attachment_url text,is_current boolean,reason text)
    WHERE d.id=a.id AND (d.filename,d.attachment_url,d.is_current) IS DISTINCT FROM (a.filename,a.attachment_url,a.is_current)`, [JSON.stringify(changes)]);
  // 완료 이력과 본문은 그대로 두고 활성 요청·자동 재시도 가능 이력만 무효화합니다.
  await db.query(`UPDATE ${schema}.attachment_extraction_runs r SET invalidated_at=COALESCE(r.invalidated_at,clock_timestamp()),
    invalidation_reason=COALESCE(r.invalidation_reason,a.reason),retry_eligible=false,
    status=CASE WHEN r.status='queued' THEN 'interrupted' ELSE r.status END,
    finished_at=CASE WHEN r.status='queued' THEN clock_timestamp() ELSE r.finished_at END,
    owner_token=CASE WHEN r.status='queued' THEN NULL ELSE r.owner_token END,
    error_code=CASE WHEN r.status IN ('queued','processing') THEN COALESCE(r.invalidation_reason,a.reason) ELSE r.error_code END,
    error=CASE WHEN r.status IN ('queued','processing') THEN $2 ELSE r.error END
    FROM ${schema}.attachment_documents d,jsonb_to_recordset($1::jsonb) a(id uuid,reason text)
    WHERE r.document_id=d.id AND d.id=a.id AND (r.status IN ('queued','processing') OR r.retry_eligible)
      AND (NOT d.is_current OR r.attachment_revision<>d.attachment_revision OR r.attachment_url<>d.attachment_url)`, [JSON.stringify(changes), attachmentObsoleteMessage]);
  await db.query(`UPDATE ${schema}.attachment_documents d SET current_run_id=NULL,updated_at=clock_timestamp()
    FROM ${schema}.attachment_extraction_runs r WHERE d.notice_key=$1 AND r.id=d.current_run_id AND r.status='interrupted' AND r.invalidated_at IS NOT NULL`, [key]);
}
