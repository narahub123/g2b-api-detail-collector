import pg from "pg";

const runtime=globalThis as typeof globalThis & {__g2bDocumentPool?:pg.Pool};
/** 수집 연결 설정을 바꾸지 않고 문서 작업기 연결·쿼리 대기 시간을 제한합니다. */
export function getDocumentPool(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL 환경변수를 설정하세요.');
 return runtime.__g2bDocumentPool ||= new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,query_timeout:15000});
}
