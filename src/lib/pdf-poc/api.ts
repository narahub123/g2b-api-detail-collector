import { guardLocalPoc, PocError } from "./contract";
import { getRun, listRuns, loadPdfAttachment } from "./store";

/** PoC 오류만 상세히 표시하고 DB와 내부 접속 정보는 응답에서 제외합니다. */
export function pocErrorResponse(error: unknown) {
  return Response.json({ error: error instanceof PocError ? error.message : "PDF PoC 요청을 처리하지 못했습니다. DB와 작업 서비스 설정을 확인하세요." },
    { status: error instanceof PocError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
}

/** 로컬 서버에서만 신뢰하는 작업 서비스에 선택한 첨부를 전달합니다. */
export async function startPdfPoc(request: Request) {
  try {
    guardLocalPoc(request);
    if (Number(request.headers.get("content-length")) > 4096) throw new PocError("요청이 너무 큽니다.", 413);
    let body;
    try { const text = await request.text(); if (Buffer.byteLength(text) > 4096) throw new Error(); body = JSON.parse(text); }
    catch { throw new PocError("첨부 식별자 JSON 요청을 확인하세요."); }
    const file = await loadPdfAttachment(body?.key, body?.fileNo, body?.seq);
    const token = process.env.PDF_POC_WORKER_TOKEN;
    if (!token || token.length < 32) throw new PocError("작업 서비스 토큰을 설정하세요.", 503);
    const url = new URL(process.env.PDF_POC_WORKER_URL || "http://127.0.0.1:8787");
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new PocError("로컬 작업 서비스 주소만 허용합니다.", 503);
    let response;
    try {
      response = await fetch(new URL("/extract", url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ key: file.key, fileNo: file.fileNo, seq: file.seq }) });
    } catch { throw new PocError("Docker 작업 서비스에 연결할 수 없습니다. 컨테이너 실행 상태를 확인하세요.", 503); }
    if (response.status === 409) throw new PocError("PDF 한 건을 처리 중입니다. 완료 후 다시 실행하세요.", 409);
    if (response.status !== 202) throw new PocError("Docker 작업 서비스가 요청을 접수하지 못했습니다. 토큰과 DB 설정을 확인하세요.", 503);
    const accepted = await response.json();
    if (typeof accepted.id !== "string" || !/^[0-9a-f-]{36}$/i.test(accepted.id)) throw new Error("작업 응답 오류");
    return Response.json({ id: accepted.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return pocErrorResponse(error); }
}

/** 같은 공고에 속한 실행만 DB에서 조회해 저장 사실을 확인합니다. */
export async function readPdfPoc(request: Request, id?: string) {
  try {
    guardLocalPoc(request);
    const key = new URL(request.url).searchParams.get("key");
    if (!key || !/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(key)) throw new PocError("공고 식별자가 필요합니다.");
    const result = id ? await getRun(id, key) : await listRuns(key);
    if (!result) throw new PocError("해당 공고의 실행 기록을 찾을 수 없습니다.", 404);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return pocErrorResponse(error); }
}
