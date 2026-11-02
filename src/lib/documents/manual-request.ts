export type ManualExtractionResult={id:string;awake:boolean;reused:boolean};

/** 기존 단건 API로 수동 추출을 접수하고 신규 접수와 활성 요청 재사용을 구분합니다. */
export async function requestManualExtraction(noticeKey:string,documentId:string,signal?:AbortSignal):Promise<ManualExtractionResult>{
 const response=await fetch(`/api/admin/documents/${encodeURIComponent(documentId)}/extractions?key=${encodeURIComponent(noticeKey)}`,{
  method:'POST',cache:'no-store',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({key:noticeKey}),
 });
 const value=await response.json();
 if(!response.ok)throw new Error(typeof value?.error==='string'?value.error:'추출 요청을 접수하지 못했습니다.');
 if(typeof value?.id!=='string'||typeof value?.awake!=='boolean')throw new Error('추출 접수 응답을 확인하지 못했습니다. 목록을 새로 확인하세요.');
 return {id:value.id,awake:value.awake,reused:response.status===200};
}

/** 작업기 연결 실패도 저장된 요청의 접수 성공으로 안내합니다. */
export function manualExtractionMessage(result:ManualExtractionResult):string{
 return result.awake?'추출 요청을 접수했습니다. 작업기가 순서대로 처리합니다.':'작업기에 연결하지 못했지만 추출 요청은 저장했습니다. 작업기 시작 또는 다음 깨우기에서 처리합니다.';
}
