import {fileDetailApi} from '@/lib/documents/file-detail-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** 현재 파일 요약과 성공 본문의 식별 정보를 읽기 전용으로 반환합니다. */
export async function GET(request:Request,{params}:{params:Promise<{documentId:string}>}){
 return fileDetailApi(request,(await params).documentId);
}
