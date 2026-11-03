import { scheduleDetailWebRequest } from "@/lib/g2b/detail-web-runtime";
import { serializeError } from "@/lib/error-diagnostics";
import { after } from "next/server";

export const runtime = "nodejs";

/** 브라우저와 분리된 after에 소비를 등록해 Next 종료가 현재 공고 처리를 기다리게 합니다. */
export async function POST(request: Request): Promise<Response> {
  try {
    const accepted = scheduleDetailWebRequest(request.headers.get("authorization"), after);
    return !accepted ? new Response(null, { status: 404 }) : Response.json({ accepted: true }, { status: 202 });
  } catch (error) {
    console.error("상세 소비 요청 실패:", serializeError(error));
    return Response.json({ error: "상세 소비 요청을 완료하지 못했습니다." }, { status: 500 });
  }
}
