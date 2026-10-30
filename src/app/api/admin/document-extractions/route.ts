import {historyApi} from '@/lib/documents/history-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** 관리자 전체 문서 추출 이력을 읽기 전용으로 반환합니다. */
export async function GET(request:Request){return historyApi(request);}
