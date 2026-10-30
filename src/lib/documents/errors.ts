import type { Failure } from "./queue";
import {ExtractionError} from './diagnostics';

/** 내부 URL·연결 정보가 포함된 원래 오류 대신 분류된 코드와 안내만 저장합니다. */
export function classifyExtractionError(error: unknown): Failure {
  if(error instanceof ExtractionError){
    const known:Record<string,[string,boolean]>={download_timeout:['첨부파일 다운로드 시간이 초과되었습니다.',true],connection_failed:['첨부파일 다운로드 연결에 실패했습니다.',true],process_exit:['추출 작업 프로세스가 비정상 종료되었습니다.',true],time_limit:['문서 처리 시간이 제한을 초과했습니다.',false],size_limit:['문서 크기가 제한을 초과했습니다.',false]};
    const entry=known[error.code];if(entry)return {code:error.code,message:entry[0],retry:entry[1]};
  }
  const message=error instanceof Error?error.message:"";
  const fixed: [RegExp,string,string][]=[
    [/암호화|PasswordException/,"encrypted_pdf","암호화된 PDF는 처리하지 않습니다."],
    [/손상|InvalidPDF|PDF 형식|읽을 수 없는/,"invalid_pdf","PDF가 손상되었거나 PDF 형식이 아닙니다."],
    [/50MiB|크기 제한/,"size_limit","PDF가 50MiB 제한을 초과했습니다."],
    [/페이지 수|페이지 제한/,"page_limit","PDF 페이지 수 제한을 초과했습니다."],
    [/5분|처리 시간/,"time_limit","PDF 처리 시간이 5분 제한을 초과했습니다."],
    [/직접 첨부|첨부파일을 고유|첨부 식별자/,"attachment_unavailable","현재 공고의 직접 첨부를 확인할 수 없습니다."],
  ];
  for(const [pattern,code,text] of fixed) if(pattern.test(message))return {code,message:text,retry:false};
  if(/작업 프로세스가 종료/.test(message))return {code:'process_exit',message:'추출 작업 프로세스가 비정상 종료되었습니다.',retry:true};
  if(/다운로드 시간 초과|Timeout|timeout/.test(message))return {code:'download_timeout',message:'첨부파일 다운로드 시간이 초과되었습니다.',retry:true};
  if(/net::|ECONN|ETIMEDOUT|fetch failed/.test(message))return {code:'connection_failed',message:'첨부파일 다운로드 연결에 실패했습니다.',retry:true};
  return {code:"extraction_failed",message:"PDF 추출 중 오류가 발생했습니다.",retry:false};
}
