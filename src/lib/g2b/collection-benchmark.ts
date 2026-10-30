import {noticeKey,noticeKeyFromParts} from './identity';
import type {ApiNotice} from './types';

export type SampleManifest={version:1;keys:string[];range?:{start:string;end:string}};
/** 중복 없는 실제 공고 세 건이 확보되면 API 순회를 종료합니다. */
export async function prepareTargets(pages:AsyncIterable<{items:ApiNotice[]}>):Promise<string[]>{
 const keys=new Set<string>();
 for await(const page of pages){for(const item of page.items){keys.add(noticeKey(item));if(keys.size===3)return [...keys];}}
 throw new Error(`측정 대상이 부족합니다: ${keys.size}/3건`);
}
/** 실행 대상을 정확히 세 개의 정규 공고 키로 제한합니다. */
export function validateManifest(value:unknown):SampleManifest{
 if(!value||typeof value!=='object')throw Error('manifest 형식을 확인하세요.');
 const candidate=value as SampleManifest;
 if(candidate.version!==1||!Array.isArray(candidate.keys)||candidate.keys.length!==3||new Set(candidate.keys).size!==3)throw Error('서로 다른 공고 세 건이 필요합니다.');
 for(const key of candidate.keys){
  if(typeof key!=='string'||!/^[A-Za-z0-9_%~.-]+--[A-Za-z0-9_%~.-]+$/.test(key))throw Error('공고 키가 잘못되었습니다.');
  const parts=key.split('--');if(parts.length!==2||noticeKeyFromParts(decodeURIComponent(parts[0]),decodeURIComponent(parts[1]))!==key)throw Error('공고 키가 정규 형식이 아닙니다.');
 }
 return candidate;
}
/** 실패한 공고를 재시도하거나 관련 공고로 확장하지 않고 순서대로 처리합니다. */
export async function runSample<T>(keys:string[],collect:(key:string)=>Promise<T>){
 const rows:({key:string;status:'succeeded';result:T}|{key:string;status:'failed'})[]=[];
 for(const key of keys){try{rows.push({key,status:'succeeded',result:await collect(key)});}catch{rows.push({key,status:'failed'});}}
 return rows;
}
