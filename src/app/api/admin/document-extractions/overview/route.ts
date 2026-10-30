import {overviewApi} from '@/lib/documents/overview-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';

/** 검색 필터와 독립된 전체 문서 현황을 읽기 전용으로 반환합니다. */
export async function GET(request:Request){return overviewApi(request);}
