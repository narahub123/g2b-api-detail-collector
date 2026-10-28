import { NextResponse } from "next/server";
import { listDbJobs } from "@/lib/g2b/collection-job-store";

export const runtime = "nodejs";

/** 수집 작업 이력의 요약만 페이지 단위로 반환합니다. */
export async function GET(request: Request) {
  const page = Number(new URL(request.url).searchParams.get("page") || "1");
  return NextResponse.json(await listDbJobs(page));
}
