import { NextResponse } from "next/server";
import { startRefresh } from "@/lib/g2b/collection-job";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { keys?: string[] };
    const job = await startRefresh(body.keys || []);
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "재수집을 시작하지 못했습니다." }, { status: 400 });
  }
}
