import {load} from 'cheerio';
import {buildProposalUrl,fetchProposalFiles,type ProposalFile} from './attachment-proposal';
import type {ProposalResolution} from './attachment-migration';

/** HTML 개체와 공백 차이만 제거해 메타데이터 파일명을 수집 이름과 비교합니다. */
export function proposalFilename(value:string):string{return load(value).text().replace(/\s+/g,' ').trim();}

/** 묶음별 조회를 한 번만 수행하고 실패도 캐시해 반복 요청을 제한합니다. */
export function createProposalResolver(fetcher:typeof fetch=fetch){
 const cache=new Map<string,Promise<ProposalFile[]>>();
 /** 조회 응답의 동일 파일순번과 파일명이 확인될 때만 실제 주소를 반환합니다. */
 return async(file:{fileNo:string;seq:number;name:string}):Promise<ProposalResolution>=>{
  let pending=cache.get(file.fileNo);
  if(!pending){pending=fetchProposalFiles(file.fileNo,undefined,fetcher);cache.set(file.fileNo,pending);}
  try{
   const matches=(await pending).filter(row=>row.atchFileSqno===file.seq&&proposalFilename(row.orgnlAtchFileNm)===proposalFilename(file.name));
   const url=matches.length===1?buildProposalUrl(matches[0]):null;
   return url?{url}:{reason:'proposal_metadata_mismatch'};
  }catch{return {reason:'proposal_metadata_unavailable'};}
 };
}
