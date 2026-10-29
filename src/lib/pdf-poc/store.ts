import { randomUUID } from "node:crypto";
import { getPool } from "../g2b/postgres-store";
import { pickPdfAttachment, PocError } from "./contract";
import type { PdfResult, PdfRun } from "./contract";

/** 기존 환경의 스키마 선택을 유지하고 SQL 식별자 삽입을 제한합니다. */
export function pocTable() {
  const schema = process.env.G2B_DB_SCHEMA || "public";
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error("DB 스키마 이름이 올바르지 않습니다.");
  return `${schema}.pdf_extraction_poc_runs`;
}

/** 원본 공고 JSON의 직접 첨부만 확인하며 정규화 과정에서 합쳐진 모달은 사용하지 않습니다. */
export async function loadPdfAttachment(key: unknown, fileNo: unknown, seq: unknown) {
  if (typeof key !== "string") throw new PocError("공고 식별자가 필요합니다.");
  const schema = pocTable().split(".")[0];
  const { rows } = await getPool().query(`SELECT detail FROM ${schema}.notices WHERE key=$1`, [key]);
  return pickPdfAttachment(key, fileNo, seq, rows[0]?.detail?.attachments ?? []);
}

/** 실행마다 별도 행을 만들어 재추출 실패가 이전 결과를 덮어쓰지 않게 합니다. */
export async function createRun(file: Awaited<ReturnType<typeof loadPdfAttachment>>) {
  const id = randomUUID();
  await getPool().query(`INSERT INTO ${pocTable()} (id,notice_key,file_no,seq,filename,attachment_url,status)
    VALUES ($1,$2,$3,$4,$5,$6,'processing')`, [id, file.key, file.fileNo, file.seq, file.name, file.url]);
  return id;
}

/** 저장된 결과만 반환하며 요청 공고와 실행의 소속을 함께 확인합니다. */
export async function getRun(id: string, key: string): Promise<PdfRun | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PocError("실행 ID가 올바르지 않습니다.");
  const { rows } = await getPool().query(`SELECT * FROM ${pocTable()} WHERE id=$1 AND notice_key=$2`, [id, key]);
  return rows[0] ?? null;
}

/** 재방문 시 최근 실행과 그 이전 성공 결과를 함께 복원합니다. */
export async function listRuns(key: string) {
  const { rows } = await getPool().query(`SELECT id,filename,status,started_at,finished_at,character_count FROM ${pocTable()}
    WHERE notice_key=$1 ORDER BY started_at DESC LIMIT 30`, [key]);
  return rows;
}

/** 결과 본문과 종료 상태를 한 SQL에서 원자적으로 저장합니다. */
export async function completeRun(id: string, result: PdfResult, peakMemory: number | null) {
  await getPool().query(`UPDATE ${pocTable()} SET status=$2,pages=$3::jsonb,page_count=$4,character_count=$5,
    extractor_version=$6,file_hash=$7,finished_at=now(),elapsed_ms=EXTRACT(EPOCH FROM (now()-started_at))*1000,
    peak_memory_bytes=$8 WHERE id=$1 AND status='processing'`,
  [id, result.characterCount ? "completed" : "no_text", JSON.stringify(result.pages), result.pageCount,
    result.characterCount, result.extractorVersion, result.fileHash, peakMemory]);
}

/** 본문을 변경하지 않고 이번 실행의 오류 또는 중단 정보만 기록합니다. */
export async function failRun(id: string, error: string, status: "failed" | "interrupted" = "failed") {
  await getPool().query(`UPDATE ${pocTable()} SET status=$2,error=$3,finished_at=now(),
    elapsed_ms=EXTRACT(EPOCH FROM (now()-started_at))*1000 WHERE id=$1 AND status='processing'`, [id, status, error.slice(0, 1000)]);
}
