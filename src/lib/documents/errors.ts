import type { Failure } from "./queue";

/** 내부 URL·연결 정보가 포함된 원래 오류 대신 분류된 코드와 안내만 저장합니다. */
export function classifyExtractionError(error: unknown): Failure {
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
  if(/net::|ECONN|ETIMEDOUT|fetch failed|다운로드 시간 초과|Timeout|timeout|작업 프로세스가 종료/.test(message))
    return {code:"temporary_download",message:"일시적인 다운로드 또는 작업 프로세스 오류가 발생했습니다.",retry:true};
  return {code:"extraction_failed",message:"PDF 추출 중 오류가 발생했습니다.",retry:false};
}
