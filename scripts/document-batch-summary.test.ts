import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';

it.each(['missing','empty','broken','partial','write-failure'])('진단 요약은 %s 로그에서도 원래 배치 결과에 영향을 주지 않습니다',async(kind)=>{
 const directory=await mkdtemp(join(tmpdir(),'g2b-probe-summary-'));
 try{
  const log=join(directory,'batch.jsonl'),summary=join(directory,'summary.md');
  const record={operation:'pdf-connection-diagnostic',runId:'run',at:'2026-11-02T13:00:00Z',host:'www.g2b.go.kr',port:443,
   phase:'tcp',family:4,address:'192.0.2.10',outcome:'stage_timeout',elapsedMs:3000};
  if(kind!=='missing')await writeFile(log,kind==='empty'?'':JSON.stringify(record)+'\n'+(kind==='broken'?'{"operation":':JSON.stringify({operation:'pdf-extraction-batch',byKind:{manual:{attempts:1}}})));
  const result=await promisify(execFile)(process.execPath,['--import','tsx','scripts/document-batch-summary.ts',log],{env:{...process.env,GITHUB_STEP_SUMMARY:kind==='write-failure'?directory:summary}});
  if(kind==='write-failure'){expect(result.stderr).toContain('경고');return;}
  const text=await readFile(summary,'utf8');expect(text).toContain('진단 기록 불완전');
  if(kind==='broken'||kind==='partial'){
   expect(text).toContain('별도 검사 대상 IP');expect(text).toContain('192.0.2.10');expect(text).toContain('원래 요청의 접속 IP');
   expect(text).toContain('다운로드 실패 후 별도 검사');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
},15000);

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
