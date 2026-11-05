import type pg from "pg";
import { DocumentError, pickPdfAttachment } from "./contract";
import type { DocumentQueue } from "./queue";

export type RegistrationSummary = { checked: number; registered: number; deferred: number };

/** 운영 승인 전에는 즉시 등록과 등록 복구의 DB 접근을 모두 차단합니다. */
export function documentRegistrationEnabled(): boolean {
  return process.env.DETAIL_PDF_REGISTRATION_ENABLED === "true";
}

/** 저장 상세에서 검증된 직접 PDF만 고르고 식별자 순서로 잠금 순서를 고정합니다. */
export function registrationAttachments(key: string, attachments: unknown): { fileNo: string; seq: number }[] {
  if (!Array.isArray(attachments)) return [];
  const files = attachments.filter(file => file && typeof file === "object" && typeof file.name === "string" && /\.pdf$/i.test(file.name.trim()));
  const counts = new Map<string, number>();
  for (const file of files) {
    const id = `${String(file.fileNo).toLowerCase()}:${file.seq}`;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const result: { fileNo: string; seq: number }[] = [];
  for (const file of files) {
    if (counts.get(`${String(file.fileNo).toLowerCase()}:${file.seq}`) !== 1) continue;
    try {
      pickPdfAttachment(key, file.fileNo, file.seq, files);
      result.push({ fileNo: file.fileNo, seq: file.seq });
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
    }
  }
  return result.sort((a, b) => a.fileNo.toLowerCase().localeCompare(b.fileNo.toLowerCase()) || a.seq - b.seq);
}

/** 등록 오류만 되돌려 상세와 복구 세대를 보존하고 다음 회차에 재시도합니다.
 * @remarks 호출자는 공고 행을 먼저 잠가야 최신 상세 판정과 새 세대 저장이 경합하지 않습니다.
 */
async function attemptRegistration(store: DocumentQueue, db: pg.PoolClient, key: string, generation: string) {
  await db.query("SAVEPOINT document_registration");
  try {
    const notice = (await db.query(`SELECT detail FROM ${store.schema}.notices WHERE key=$1`, [key])).rows[0];
    const runs = await store.enqueueManyInTransaction(db, key, registrationAttachments(key, notice?.detail?.attachments), "automatic");
    const registered = runs.filter(run => !run.reused).length;
    const blocked = (await db.query(`SELECT EXISTS(SELECT 1 FROM ${store.schema}.attachment_documents d
      JOIN ${store.schema}.attachment_extraction_runs r ON r.document_id=d.id
      WHERE d.notice_key=$1 AND r.status='processing' AND r.invalidated_at IS NOT NULL) pending`, [key])).rows[0].pending;
    if (blocked) {
      await db.query(`UPDATE ${store.schema}.document_registration_handoffs SET next_attempt_at=clock_timestamp()+interval '60 seconds'
        WHERE notice_key=$1 AND generation=$2`, [key, generation]);
      await db.query("RELEASE SAVEPOINT document_registration");
      return { registered, deferred: true };
    }
    await db.query(`DELETE FROM ${store.schema}.document_registration_handoffs WHERE notice_key=$1 AND generation=$2`, [key, generation]);
    await db.query("RELEASE SAVEPOINT document_registration");
    return { registered, deferred: false };
  } catch {
    await db.query("ROLLBACK TO SAVEPOINT document_registration");
    await db.query("RELEASE SAVEPOINT document_registration");
    await db.query(`UPDATE ${store.schema}.document_registration_handoffs SET attempts=attempts+1,
      next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE notice_key=$1 AND generation=$2`, [key, generation]);
    console.warn("PDF 등록을 보류했습니다. 최신 상세를 기준으로 복구합니다.");
    return { registered: 0, deferred: true };
  }
}

/** 상세와 같은 커밋에 등록 요청만 남겨 공용 임대 잠금 밖에서 복구하도록 합니다. */
export async function requestNoticeDocumentRegistrationInTransaction(store: DocumentQueue, db: pg.PoolClient, key: string): Promise<string | undefined> {
  if (!documentRegistrationEnabled()) return;
  const row = (await db.query(`INSERT INTO ${store.schema}.document_registration_handoffs(notice_key) VALUES($1)
    ON CONFLICT(notice_key) DO UPDATE SET generation=gen_random_uuid(),requested_at=clock_timestamp(),
      next_attempt_at=clock_timestamp(),attempts=0 RETURNING generation`, [key])).rows[0];
  return row.generation;
}

/** 문서 단독 접수에서는 복구 기록과 즉시 등록을 같은 트랜잭션에서 처리합니다. */
export async function registerNoticeDocumentsInTransaction(store: DocumentQueue, db: pg.PoolClient, key: string) {
  const generation = await requestNoticeDocumentRegistrationInTransaction(store, db, key);
  if (!generation) return { registered: 0, deferred: false };
  return attemptRegistration(store, db, key, generation);
}

/** 재시작 후 최신 공고를 잠가 제한된 수의 등록 누락을 복구하며 개별 실패는 지연합니다. */
export async function recoverDocumentRegistrations(store: DocumentQueue,
  options: { noticeKey?: string; limit?: number; stop?: () => boolean } = {}): Promise<RegistrationSummary> {
  const summary: RegistrationSummary = { checked: 0, registered: 0, deferred: 0 };
  if (!documentRegistrationEnabled()) return summary;
  try {
    for (let i = 0; i < (options.limit ?? 20) && !options.stop?.(); i++) {
      const result = await store.transaction(async db => {
        // 상세 저장과 같은 공고→복구 기록→문서 순서로 잠그고 다른 복구가 잠근 공고는 건너뜁니다.
        const notice = (await db.query(`SELECT n.key FROM ${store.schema}.notices n
          JOIN ${store.schema}.document_registration_handoffs h ON h.notice_key=n.key
          WHERE h.next_attempt_at<=clock_timestamp() AND ($1::text IS NULL OR n.key=$1)
          ORDER BY h.next_attempt_at,h.requested_at,n.key LIMIT 1 FOR UPDATE OF n SKIP LOCKED`, [options.noticeKey ?? null])).rows[0];
        if (!notice || options.stop?.()) return null;
        const row = (await db.query(`SELECT generation FROM ${store.schema}.document_registration_handoffs
          WHERE notice_key=$1 AND next_attempt_at<=clock_timestamp() FOR UPDATE`, [notice.key])).rows[0];
        return row ? attemptRegistration(store, db, notice.key, row.generation) : null;
      });
      if (!result) break;
      summary.checked++;
      summary.registered += result.registered;
      if (result.deferred) summary.deferred++;
    }
  } catch {
    // 복구 자체의 연결 장애도 상세 수집이나 기존 PDF 실행의 실패로 전파하지 않습니다.
    console.warn("PDF 등록 복구를 완료하지 못했습니다. 복구 기록은 다음 실행에 유지합니다.");
    summary.deferred++;
  }
  return summary;
}
