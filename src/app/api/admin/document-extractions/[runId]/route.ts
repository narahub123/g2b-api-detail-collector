import {historyApi} from '@/lib/documents/history-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** 단일 추출 시도와 재시도 연결을 반환합니다. */
export async function GET(request:Request,{params}:{params:Promise<{runId:string}>}){return historyApi(request,(await params).runId);}
