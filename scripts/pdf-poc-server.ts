import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { chromium } from "playwright-core";
import pg from "pg";
import { getPool } from "../src/lib/g2b/postgres-store";
import { PocError } from "../src/lib/pdf-poc/contract";
import { createRun, loadPdfAttachment, completeRun, failRun, pocTable } from "../src/lib/pdf-poc/store";
import { superviseExtraction } from "../src/lib/pdf-poc/supervisor";

const token = process.env.PDF_POC_WORKER_TOKEN;
process.env.G2B_CHROME_PATH ||= chromium.executablePath();
if (!token || token.length < 32) throw new Error("PDF_POC_WORKER_TOKEN에 32자 이상 토큰을 설정하세요.");
const db = getPool();
// Neon 트랜잭션 풀러는 세션 잠금을 보장하지 않으므로 잠금만 직접 연결을 사용합니다.
const directUrl = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL!);
if (directUrl.hostname.endsWith(".neon.tech")) directUrl.hostname = directUrl.hostname.replace("-pooler.", ".");
if (directUrl.hostname.includes("-pooler")) throw new Error("잠금용 DATABASE_URL_UNPOOLED에 직접 연결 주소를 설정하세요.");
const lock = new pg.Client({ connectionString: directUrl.toString(), connectionTimeoutMillis: 15_000 });
await lock.connect();
const lockName = `g2b-pdf-poc:${pocTable()}`;
const locked = await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lockName]);
if (!locked.rows[0].locked) { await lock.end(); await db.end(); throw new Error("다른 PDF PoC 서비스가 이미 실행 중입니다."); }
// 단일 서비스 잠금을 얻은 뒤에만 이전 프로세스의 미완료 실행을 정리합니다.
await db.query(`UPDATE ${pocTable()} SET status='interrupted',error='작업 서비스가 재시작되었습니다.',finished_at=now(),
  elapsed_ms=EXTRACT(EPOCH FROM(now()-started_at))*1000 WHERE status='processing'`);
let busy = false;
let active: Promise<void> | undefined;
const shutdown = new AbortController();

const server = createServer(async (request, response) => {
  /** 외부에 본문이나 내부 환경을 노출하지 않고 처리 결과만 응답합니다. */
  const reply = (status: number, body: object) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); };
  const authorization = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { reply(401, { error: "작업 서비스 인증 실패" }); return; }
  if (request.method === "GET" && request.url === "/health") { reply(200, { ready: !shutdown.signal.aborted, busy }); return; }
  if (request.method !== "POST" || request.url !== "/extract") { reply(404, { error: "경로 없음" }); return; }
  if (busy || shutdown.signal.aborted) { reply(409, { error: "PDF 한 건을 처리 중입니다. 완료 후 다시 실행하세요." }); return; }
  busy = true;
  try {
    let body = "";
    for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 4096) throw new PocError("요청이 너무 큽니다.", 413); }
    let input;
    try { input = JSON.parse(body); } catch { throw new PocError("JSON 요청이 올바르지 않습니다."); }
    const file = await loadPdfAttachment(input?.key, input?.fileNo, input?.seq);
    const id = await createRun(file);
    active = (async () => {
      try {
        const { result, peakMemory } = await superviseExtraction(id, file.key, shutdown.signal);
        await completeRun(id, result, peakMemory);
      } catch (error) {
        const message = error instanceof Error ? error.message : "PDF 추출 실패";
        await failRun(id, message, shutdown.signal.aborted ? "interrupted" : "failed").catch(() => console.error("PDF 실패 상태를 저장하지 못했습니다. 재시작 시 복구합니다."));
      } finally { busy = false; }
    })();
    reply(202, { id });
  } catch (error) {
    busy = false;
    reply(error instanceof PocError ? error.status : 500, { error: error instanceof PocError ? error.message : "첨부 확인 또는 실행 기록 저장에 실패했습니다." });
  }
});
server.requestTimeout = 10_000;
lock.on("error", () => { console.error("PDF 단일 실행 잠금 연결이 종료되었습니다."); void close(); });

/** 컨테이너 종료 요청을 받으면 실행 자원을 먼저 정리한 뒤 DB 잠금을 해제합니다. */
async function close() {
  if (shutdown.signal.aborted) return;
  shutdown.abort(); server.close();
  await active;
  await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockName]).catch(() => undefined);
  await lock.end(); await db.end();
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
server.listen(8787, "0.0.0.0", () => console.log("PDF PoC 작업 서비스 준비 완료"));
