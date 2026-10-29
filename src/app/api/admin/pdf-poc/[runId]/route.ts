import { readPdfPoc } from "@/lib/pdf-poc/api";

export const runtime = "nodejs";
/** 요청 공고에 연결된 실행의 저장 텍스트와 상태를 조회합니다. */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  return readPdfPoc(request, (await params).runId);
}
