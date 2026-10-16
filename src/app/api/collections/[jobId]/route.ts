import { NextResponse } from "next/server";
import { getCollectionJob } from "@/lib/g2b/collection-job";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const job = await getCollectionJob(jobId);
  return job ? NextResponse.json(job) : NextResponse.json({ error: "작업을 찾을 수 없습니다." }, { status: 404 });
}
