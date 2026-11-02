import {pickPdfAttachment} from './contract';

export type DocumentRequestState={canRequest:boolean;reason:string|null;active:{id:string;status:'queued'|'processing'}|null};

/** 현재 공고의 원본 첨부와 문서 전체의 활성 요청으로 수동 추출 가능 여부를 판단합니다. */
export function documentRequestState(key:string,fileNo:string,seq:number,attachments:unknown,active:DocumentRequestState['active']):DocumentRequestState{
 // 오래된 문서 플래그 대신 접수 API와 동일한 직접 첨부 검증을 적용합니다.
 const files=Array.isArray(attachments)?attachments.filter((file):file is {name:string;url:string|null}=>
  !!file&&typeof file.name==='string'&&(typeof file.url==='string'||file.url===null)):[];
 try{pickPdfAttachment(key,fileNo,seq,files);}
 catch{return {canRequest:false,reason:'현재 공고의 직접 첨부 PDF만 추출할 수 있습니다. 이전 첨부와 지원하지 않는 파일은 요청할 수 없습니다.',active};}
 return active?{canRequest:false,reason:'이미 대기 또는 처리 중인 요청이 있습니다.',active}:{canRequest:true,reason:null,active:null};
}
