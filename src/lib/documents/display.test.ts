import {expect,it,vi} from 'vitest';
import {documentTime,documentWorkLabel} from './display';
it('서버·브라우저 로캘 데이터가 달라도 동일한 한국 시각을 표시합니다',()=>{
 const locale=vi.spyOn(Date.prototype,'toLocaleString').mockReturnValue('다른 로캘 표현');
 try{expect(documentTime('2026-10-30T00:00:00Z')).toBe('2026-10-30 09:00:00 (KST)');expect(documentTime(null)).toBe('기록 없음');}
 finally{locale.mockRestore();}
});

it.each([
 [{source:'manual',purpose:'initial' as const},'수동'],
 [{source:'automatic',purpose:'initial' as const},'자동 신규 추출'],
 [{source:'automatic',purpose:'reextract' as const},'자동 재추출'],
 [{source:'automatic'},'자동 추출'],
 [{source:'poc_import',purpose:'reextract' as const},'이전 실행'],
])('실행의 출처와 목적을 함께 구분합니다: %j',(run,label)=>{
 expect(documentWorkLabel(run)).toBe(label);
});
