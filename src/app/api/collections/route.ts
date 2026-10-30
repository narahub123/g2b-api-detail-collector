import { NextResponse } from "next/server";
import { getLatestCollectionJob, startCollection } from "@/lib/g2b/collection-job";
import { parsePostedTimeRange } from "@/lib/g2b/date-range";

export const runtime = "nodejs";

/** 최근 수집 작업의 저장된 상태를 반환합니다. */
export async function GET() {
  return NextResponse.json(await getLatestCollectionJob());
}

/** 날짜 또는 서울 시분 범위를 검증하고 수동 수집을 시작합니다. */
export async function POST(request: Request) {
  try {
    const body = await request.json() as { start?: string; end?: string };
    const range = parsePostedTimeRange(body.start || "", body.end || "");
    const job = await startCollection(range);
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "수집을 시작하지 못했습니다." }, { status: 400 });
  }
}
