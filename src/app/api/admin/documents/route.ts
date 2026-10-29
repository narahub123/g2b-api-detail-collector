import {documentApi} from '@/lib/documents/api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** 공고의 본문 없는 파일별 요약을 로컬 관리자에게 반환합니다. */
export async function GET(request:Request){return documentApi(request);}