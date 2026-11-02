import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';

it('정상 배치도 종류별 처리 결과와 남은 대기를 Actions 요약에 기록합니다',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'g2b-kind-summary-'));
 try{
  const log=join(directory,'batch.jsonl'),summary=join(directory,'summary.md');
  await writeFile(log,'일반 로그\n'+JSON.stringify({operation:'pdf-extraction-batch',reason:'count_limit',byKind:{
   manual:{attempts:2,completed:1,failed:1,noText:0,remainingReady:3},
   initial:{attempts:4,completed:3,failed:0,noText:1,remainingReady:5},
   reextract:{attempts:6,completed:4,failed:1,noText:1,remainingReady:7}
  }})+'\n');
  await promisify(execFile)(process.execPath,['--import','tsx','scripts/document-batch-summary.ts',log],{env:{...process.env,GITHUB_STEP_SUMMARY:summary}});
  const text=await readFile(summary,'utf8');
  expect(text).toContain('| 수동 요청 | 2 | 1 | 1 | 0 | 3 |');
  expect(text).toContain('| 신규 문서 | 4 | 3 | 0 | 1 | 5 |');
  expect(text).toContain('| 재추출 | 6 | 4 | 1 | 1 | 7 |');
 }finally{await rm(directory,{recursive:true,force:true});}
});
