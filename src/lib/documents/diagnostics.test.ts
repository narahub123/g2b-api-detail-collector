import {expect,it} from 'vitest';
import {sanitizeDiagnostic,diagnosticError,ExtractionError} from './diagnostics';
import {classifyExtractionError} from './errors';

it('URL 인증·쿼리와 연결 문자열·토큰을 오류에서 제거하고 길이를 제한합니다',()=>{
 const value=sanitizeDiagnostic('https://alice:password@example.com/file?token=secret#private postgres://u:pass@db/name Authorization: Bearer abc123 Cookie: session=private');
 expect(value).not.toMatch(/password|secret|private|abc123|session=|u:pass/);
 expect(sanitizeDiagnostic('x'.repeat(3000))).toHaveLength(2000);
});
it('원본 원인과 스택을 제한해 보존합니다',()=>{
 const value=diagnosticError(new Error('표시 오류',{cause:new Error('원인')}));
 expect(value.message).toBe('표시 오류');expect(value.cause?.message).toBe('원인');expect(value.stack).toContain('Error');
});
it('JSON과 헤더 형식의 인증 정보도 정제합니다',()=>{
 const value=sanitizeDiagnostic('{"password":"hunter2","token":"abc","Authorization":"Bearer private","Cookie":"session=hidden"}');
 expect(value).not.toMatch(/hunter2|abc|private|hidden/);
});
it('환경변수 접두사가 있는 토큰과 독립 Bearer 자격 증명도 제거합니다',()=>{
 expect(sanitizeDiagnostic('PDF_WORKER_TOKEN=hidden-value ACCESS_TOKEN=private-value Bearer opaque-value')).not.toMatch(/hidden-value|private-value|opaque-value/);
});
it('다운로드 시간 초과와 프로세스 종료를 구분합니다',()=>{
 expect(classifyExtractionError(new ExtractionError('download_timeout','다운로드 시간 초과')).code).toBe('download_timeout');
 expect(classifyExtractionError(new ExtractionError('process_exit','작업 프로세스 종료')).code).toBe('process_exit');
});
