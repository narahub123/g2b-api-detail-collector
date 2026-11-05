import { KST_OFFSET_MS } from '@/lib/constants';
import type {ExtractionPurpose} from './priority';

/** 로캘 데이터 차이로 화면 초기화가 실패하지 않도록 한국 시각을 고정 형식으로 표시합니다. */
export function documentTime(value:string|null|undefined){
 if(!value)return '기록 없음';
 const time=new Date(value).getTime();
 return Number.isFinite(time)?`${new Date(time+KST_OFFSET_MS).toISOString().slice(0,19).replace('T',' ')} (KST)`:'기록 없음';
}
/** DB 숫자 문자열도 처리하고 관측되지 않은 시간은 추정하지 않습니다. */
export function documentDuration(value:number|null){return value===null?'기록 없음':`${(Number(value)/1000).toFixed(1)}초`;}
/** 실행 출처를 관리자에게 읽기 쉬운 이름으로 변환합니다. */
export function documentSource(value:string){return ({automatic:'자동 추출',manual:'수동 추출',poc_import:'이전 실행'} as Record<string,string>)[value]??value;}

/** 실행 출처와 요청 목적을 함께 구분하고 목적이 없는 이전 기록도 표시합니다. */
export function documentWorkLabel(run:{source:string;purpose?:ExtractionPurpose}){
 if(run.source==='manual')return '수동';
 if(run.source==='automatic'&&run.purpose==='initial')return '자동 신규 추출';
 if(run.source==='automatic'&&run.purpose==='reextract')return '자동 재추출';
 return documentSource(run.source);
}
