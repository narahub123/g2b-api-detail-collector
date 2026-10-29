import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getPool } from "../src/lib/g2b/postgres-store";
import { extractAttachmentPdf } from "../src/lib/documents/attachment-extraction";
import { getRun, loadPdfAttachment } from "../src/lib/pdf-poc/store";

/** 부모와 독립된 실행 단위에서 브라우저와 PDF 파서를 처리합니다. */
async function main() {
  const [id, key, directory] = process.argv.slice(2);
  const run = await getRun(id, key);
  if (!run || run.status !== "processing") throw new Error("처리할 실행 기록이 없습니다.");
  const file = await loadPdfAttachment(key, run.file_no, run.seq);
  const result = await extractAttachmentPdf(file, join(directory, "downloads"), new AbortController().signal);
  await writeFile(join(directory, "result.json"), JSON.stringify(result), { mode: 0o600 });
}

main().catch(async error => {
  // 원본 본문과 연결정보가 로그로 유출되지 않게 오류는 로컬 임시 파일로만 전달합니다.
  await writeFile(join(process.argv[4], "error.json"), JSON.stringify({ error: error instanceof Error ? error.message : "추출 실패" })).catch(() => undefined);
  process.exitCode = 1;
}).finally(() => getPool().end());
