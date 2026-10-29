import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';
it('일반 마이그레이션은 PoC를 생성하지 않고 제거 마이그레이션을 적용합니다',async()=>{
 const script=await readFile('scripts/migrate-db.mjs','utf8');
 expect(script).not.toContain('0005-pdf-extraction-poc.sql');expect(script).toContain('0007-retire-pdf-poc.sql');
 const docker=await readFile('Dockerfile.pdf-worker','utf8');expect(docker).toContain('scripts/document-worker.ts');expect(docker).not.toContain('8787');
});
