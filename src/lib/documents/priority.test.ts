import {expect,it} from 'vitest';
import {workKind} from './priority';

it('수동은 목적과 무관하게 최우선 종류이고 자동 신규·재추출을 구분합니다',()=>{
 expect(workKind({source:'manual',purpose:'reextract'})).toBe('manual');
 expect(workKind({source:'manual',purpose:'initial'})).toBe('manual');
 expect(workKind({source:'automatic',purpose:'initial'})).toBe('initial');
 expect(workKind({source:'automatic',purpose:'reextract'})).toBe('reextract');
});
