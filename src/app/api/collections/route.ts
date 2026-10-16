import { NextResponse } from "next/server";
import { getLatestCollectionJob, startCollection } from "@/lib/g2b/collection-job";
import { parsePostedDateRange } from "@/lib/g2b/date-range";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getLatestCollectionJob());
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { start?: string; end?: string };
    const range = parsePostedDateRange(body.start || "", body.end || "");
    const job = await startCollection(range);
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "수집을 시작하지 못했습니다." }, { status: 400 });
  }
}
