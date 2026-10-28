import { NextResponse } from "next/server";
import { getAutomationSettings, updateAutomationSettings } from "@/lib/g2b/automation-store";
import type { AutomationInput } from "@/lib/g2b/automation-schedule";

export const runtime = "nodejs";

/** 현재 자동 수집 설정을 관리자 화면에 반환합니다. */
export async function GET() {
  try { return NextResponse.json(await getAutomationSettings()); }
  catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "자동 설정을 읽지 못했습니다." }, { status: 500 });
  }
}

/** 활성화 여부와 서울 예약 시각을 검증해 저장합니다. */
export async function PUT(request: Request) {
  try {
    const input = await request.json() as AutomationInput;
    return NextResponse.json(await updateAutomationSettings(input));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "자동 설정을 저장하지 못했습니다." }, { status: 400 });
  }
}
