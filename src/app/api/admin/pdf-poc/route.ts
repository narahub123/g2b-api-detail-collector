import { startPdfPoc, readPdfPoc } from "@/lib/pdf-poc/api";

export const runtime = "nodejs";
/** 선택한 직접 첨부 PDF의 추출을 별도 작업 서비스에 접수합니다. */
export const POST = startPdfPoc;
/** 관리자 재방문 시 해당 공고의 PoC 실행 이력을 조회합니다. */
export async function GET(request: Request) { return readPdfPoc(request); }
