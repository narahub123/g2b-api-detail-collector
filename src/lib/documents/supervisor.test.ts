import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseExtraction } from "./supervisor";
import { classifyExtractionError } from "./errors";
const fixtures: string[] = [];

/** 실제 자식 프로세스의 종료와 임시 자료 정리를 확인할 실행 파일을 만듭니다. */
async function script(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "pdf-supervisor-test-")); fixtures.push(directory);
  const path = join(directory, "child.mjs");
  await writeFile(path, `import {mkdir,writeFile} from 'node:fs/promises'; import {join} from 'node:path'; const dir=process.argv[4]; ${body}`);
  return path;
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("PDF 작업 프로세스 경계", () => {
  it.each(['connection_failed','download_timeout','download_http_retry'])('자식의 %s 오류를 재시도 가능한 상태로 전달합니다',async(code)=>{
    const path=await script(`await writeFile(join(dir,'error.json'),JSON.stringify({code:${JSON.stringify(code)},error:'첨부파일 다운로드 연결에 실패했습니다.',diagnostic:{name:'ExtractionError',message:'연결 실패'}})); process.exitCode=1;`);
    const error=await superviseExtraction('id','key',new AbortController().signal,{script:path}).catch(e=>e);
    expect(classifyExtractionError(error)).toMatchObject({code,retry:true});
  });
  it('자식 프로세스의 점검 분류를 보존합니다',async()=>{
    const path=await script(`await writeFile(join(dir,'error.json'),JSON.stringify({error:'점검',maintenance:{code:'g2b_maintenance',source:'download',detectedAt:new Date().toISOString(),message:'나라장터 시스템 점검으로 보류'}})); process.exitCode=1;`);
    await expect(superviseExtraction('id','key',new AbortController().signal,{script:path})).rejects.toMatchObject({maintenance:{code:'g2b_maintenance',source:'download'}});
  });
  it('진행 메시지와 정제된 원본 오류·종료 코드를 전달합니다',async()=>{
    const path=await script(`process.send?.({type:'progress',progress:{stage:'extracting',at:new Date().toISOString(),currentPage:2,completedPages:1,totalPages:3}}); await writeFile(join(dir,'error.json'),JSON.stringify({error:'파서 실패',diagnostic:{name:'ParserError',message:'원본 오류',stack:'원본 스택'}})); process.exitCode=1;`);
    const onProgress=vi.fn();
    const error=await superviseExtraction('id','key',new AbortController().signal,{script:path,onProgress}).catch(e=>e);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({stage:'extracting',currentPage:2}));
    expect(error.diagnostic).toMatchObject({name:'ParserError',message:'원본 오류',exitCode:1});
  });
  it("시간 초과로 멈춘 프로세스를 종료하고 임시 경로를 지웁니다", async () => {
    const before = (await readdir(tmpdir())).filter(name => name.startsWith("g2b-pdf-worker-"));
    const path = await script("setInterval(()=>{},1000);");
    const error=await superviseExtraction("id", "key", new AbortController().signal, { script: path, timeoutMs: 800 }).catch(error=>error);
    expect(error).toMatchObject({code:'time_limit',message:expect.stringContaining('시간')});
    expect(Object.hasOwn(error,'exitCode')).toBe(true);
    expect(Object.hasOwn(error,'signal')).toBe(true);
    expect(error.cause).toBeUndefined();
    expect((await readdir(tmpdir())).filter(name => name.startsWith("g2b-pdf-worker-"))).toEqual(before);
  });
  it("다운로드가 끝나기 전에도 크기를 제한합니다", async () => {
    const path = await script("await mkdir(join(dir,'downloads')); await writeFile(join(dir,'downloads','file'),Buffer.alloc(100)); setInterval(()=>{},1000);");
    await expect(superviseExtraction("id", "key", new AbortController().signal, { script: path, maxBytes: 10, timeoutMs: 5000 })).rejects.toThrow("다운로드");
  });
  it.skipIf(process.platform !== "linux")("분리된 프로세스 그룹의 자식도 종료합니다", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdf-supervisor-test-")); fixtures.push(directory);
    const pidFile = join(directory, "grandchild.pid");
    const path = await script(`const {spawn}=await import('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); await writeFile(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`);
    await expect(superviseExtraction("id", "key", new AbortController().signal, { script: path, timeoutMs: 1800 })).rejects.toThrow("시간");
    const pid = Number(await readFile(pidFile, "utf8"));
    // init이 수거하기 전 좀비 상태도 실행이 종료된 상태로 봅니다.
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    expect(!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
  });
});

it('실제 자식 오류가 작업기와 SQL 저장 인자까지 확장 속성을 유지합니다',async()=>{
 const {pathToFileURL}=await import('node:url');
 const {resolve}=await import('node:path');
 const {DocumentQueue}=await import('./queue');
 const {runBatch}=await import('./worker');
 const moduleUrl=pathToFileURL(resolve('src/lib/documents/diagnostics.ts')).href;
 const path=await script(`const {diagnosticError,ExtractionError}=await import(${JSON.stringify(moduleUrl)});
 const cause=Object.assign(new AggregateError([{code:'EHOSTUNREACH',address:'192.0.2.2'}],'network'),{code:'ETIMEDOUT',errno:-1,syscall:'connect',address:'192.0.2.1',port:443,status:502,extra:{attempt:2},token:'private-token'});
 const error=new ExtractionError('connection_failed','download failed',{cause});
 await writeFile(join(dir,'error.json'),JSON.stringify({code:error.code,error:error.message,diagnostic:diagnosticError(error)}));process.exitCode=1;`);
 let owner='';
 const query=vi.fn(async(sql:string,_params?:unknown[])=>{
  if(sql.includes(' valid FROM'))return {rows:[{valid:true}]};
  if(sql.includes('SELECT d.*'))return {rows:[{id:'doc',active_chain_id:'chain',current_run_id:'run'}]};
  if(sql.includes('SELECT * FROM'))return {rows:[{id:'run',status:'processing',owner_token:owner,chain_id:'chain',attempt_number:3}]};
  return {rows:[]};
 });
 const queue=new DocumentQueue({connect:async()=>({query,release:vi.fn()})} as never);
 const store={acquire:async(token:string)=>{owner=token;return true;},release:async()=>{},renew:async()=>true,
  recover:async()=>({checked:0,recovered:0,exhausted:0}),claim:async()=>({id:'run',notice_key:'key',source:'manual',attempt_number:3}),
  readyCounts:async()=>({manual:0,initial:0,reextract:0}),fail:queue.fail.bind(queue)};
 let received:unknown;
 await runBatch(store as never,{mode:'local',limit:1,extract:async()=>{
  try{return await superviseExtraction('run','key',new AbortController().signal,{script:path});}catch(error){received=error;throw error;}
 }});
 expect(received).toMatchObject({code:'connection_failed',cause:{cause:{code:'ETIMEDOUT'}},diagnostic:{exitCode:1,signal:null}});
 const update=query.mock.calls.find(([sql])=>sql.includes('diagnostic_error=$6'))!;
 expect(update[1]?.[2]).toBe('connection_failed');
 const stored=JSON.parse(update[1]?.[5] as string);
 expect(stored).toMatchObject({code:'connection_failed',exitCode:1,signal:null,cause:{code:'ETIMEDOUT',errno:-1,syscall:'connect',address:'192.0.2.1',port:443,status:502,extra:{attempt:2},errors:[{code:'EHOSTUNREACH',address:'192.0.2.2'}]}});
 expect(stored.cause.stack).toContain('AggregateError');
 expect(JSON.stringify(stored)).not.toContain('private-token');
});
