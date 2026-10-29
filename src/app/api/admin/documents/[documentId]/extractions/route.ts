import {documentApi} from '@/lib/documents/api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** 공고·문서·실행의 소속과 로컬 접근을 검사한 뒤 요청을 처리합니다. */
export async function GET(request:Request,{params}:{params:Promise<{documentId:string}>}){return documentApi(request,await params);}
/** 공고·문서·실행의 소속과 로컬 접근을 검사한 뒤 요청을 처리합니다. */
export async function POST(request:Request,{params}:{params:Promise<{documentId:string}>}){return documentApi(request,await params);}
