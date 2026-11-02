export type ExtractionPurpose='initial'|'reextract';
export type WorkKind='manual'|ExtractionPurpose;
export type ReadyCounts=Record<WorkKind,number>;

/** 수동 요청은 목적보다 우선하고 자동 요청은 최초 추출과 재추출로 구분합니다. */
export function workKind(run:{source:string;purpose?:ExtractionPurpose}):WorkKind{
 return run.source==='manual'?'manual':run.purpose==='reextract'?'reextract':'initial';
}
