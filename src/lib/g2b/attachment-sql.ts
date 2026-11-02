/** 큐와 사전 집계에서 같은 외부 다운로드 경로를 사용합니다. */
export function downloadableAttachmentSql(url:string):string{
 return `(${url} LIKE 'https://www.g2b.go.kr/%/downloadFile.do?%' OR ${url} LIKE 'https://www.g2b.go.kr/fs/fsc/fsca/fileUpload.do?k00=%&fileNo=%&fileSeq=%')`;
}
