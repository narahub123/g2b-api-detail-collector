import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentQueue } from "./queue";
import { PdfDispatchState } from "./dispatch-state";
import { testAttachment } from "./test-attachments";

type Message={type:string;boundary?:string;generation?:string;httpStatus?:number;runUrl?:string;result?:{reason:string;generation?:string;attempted:boolean;runUrl?:string}};
type HttpCall={body:unknown;owner:string|null;generation:string|null;responded:boolean;testAuthorization:boolean};

/** 요청 도착과 IPC 경계를 임의 지연 없이 부모 테스트에 전달합니다. */
function signal<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}

/** IPC나 HTTP가 도착하지 않으면 명확히 실패하고 기한 타이머는 정리합니다. */
async function within<T>(promise:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error("종료 경계 확인 시간이 초과되었습니다.")),60_000);
  })]);}finally{clearTimeout(timer);}
}

const live=process.env.LIVE_DB_TEST==="1"&&!!process.env.DATABASE_URL;
describe.skipIf(!live)("PDF 실행 요청 프로세스 강제 종료",{timeout:120_000},()=>{
  const schema=`pdf_dispatch_crash_${randomUUID().replaceAll("-","")}`;
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:6,connectionTimeoutMillis:10_000,query_timeout:15_000});
  const repository="narahub123/g2b-api-detail-collector",key="R26BK10000001--000",fileNo=randomUUID();
  const files=[1,2].map(seq=>testAttachment(key,fileNo,seq));
  const queue=new DocumentQueue(pool,schema),store=new PdfDispatchState(pool,schema);
  const children=new Set<ChildProcess>(),sockets=new Set<Socket>(),heldResponses=new Set<ServerResponse>();
  const reports:unknown[]=[];
  let created=false,endpoint="",holdResponses=false,calls:HttpCall[]=[];
  let arrived=signal<HttpCall>();

  /** 자식 프로세스와 독립된 연결에서 커밋된 실행 요청을 읽습니다. */
  async function state(){return(await pool.query(`SELECT * FROM ${schema}.pdf_dispatch_state WHERE repository=$1`,[repository])).rows[0];}
  /** 실제 HTTP를 수신하고 응답 대기 또는 성공 응답의 경계를 만듭니다. */
  const server=createServer((request,response)=>{
    const chunks:Buffer[]=[];
    request.on("data",chunk=>chunks.push(Buffer.from(chunk)));
    request.on("end",()=>{void(async()=>{
      try{
        const row=await state();
        const call:HttpCall={body:JSON.parse(Buffer.concat(chunks).toString("utf8")),owner:row.owner_token,generation:row.claimed_generation,
          responded:!holdResponses,testAuthorization:request.headers.authorization==="Bearer dispatch-crash-test-token"};
        calls.push(call);
        if(holdResponses){heldResponses.add(response);response.once("close",()=>heldResponses.delete(response));}
        else response.writeHead(200,{"Content-Type":"application/json"}).end(JSON.stringify({workflow_run_id:calls.length,
          html_url:`https://github.com/${repository}/actions/runs/${calls.length}`}));
        arrived.resolve(call);
      }catch{response.writeHead(500).end();}
    })();});
  });
  server.on("connection",socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});

  /** 실제 호출 조정기를 별도 프로세스에서 실행하고 종료까지 추적합니다. */
  function start(boundary:string){
    const child=fork("src/lib/documents/fixtures/held-dispatch-process.ts",{execArgv:["--import","tsx"],silent:true,
      env:{...process.env,GITHUB_ACTIONS:"false",G2B_DB_SCHEMA:schema,DISPATCH_TEST_BOUNDARY:boundary,
        DISPATCH_TEST_NOTICE_KEY:key,DISPATCH_TEST_FILE_NO:fileNo,DISPATCH_TEST_ENDPOINT:endpoint}});
    children.add(child);
    const message=signal<Message>();child.once("message",value=>message.resolve(value as Message));
    const exited=once(child,"exit");void exited.catch(()=>undefined);
    child.once("exit",()=>children.delete(child));
    return {child,exited,message:message.promise};
  }
  /** 정상 정리 절차 없이 프로세스를 종료하고 후속 테스트에 남기지 않습니다. */
  async function kill(handle:ReturnType<typeof start>){
    const forced=handle.child.exitCode===null&&handle.child.signalCode===null?handle.child.kill("SIGKILL"):false;
    await within(handle.exited);
    return forced;
  }
  /** 호출권과 5분 간격을 별도로 확인한 뒤 테스트 스키마의 시각만 앞당깁니다. */
  async function allowRestart(){
    expect(await store.claim(repository)).toEqual({reason:"in_flight"});
    await pool.query(`UPDATE ${schema}.pdf_dispatch_state SET lease_expires_at=clock_timestamp()-interval '1 second'`);
    expect(await store.claim(repository)).toEqual({reason:"cooldown"});
    await pool.query(`UPDATE ${schema}.pdf_dispatch_state SET last_attempt_at=clock_timestamp()-interval '5 minutes'`);
  }
  beforeAll(async()=>{
    await pool.query(`CREATE SCHEMA ${schema}`);created=true;
    await pool.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
    for(const file of ["0006-document-extraction.sql","0008-extraction-diagnostics.sql","0010-single-document-content.sql",
      "0011-stage-timings.sql","0012-extraction-priority.sql","0018-document-registration.sql","0019-attachment-lifecycle.sql","0020-pdf-dispatch.sql"]){
      await pool.query((await readFile(`db/migrations/${file}`,"utf8")).replaceAll("public.",`${schema}.`));
    }
    server.listen(0,"127.0.0.1");await once(server,"listening");
    const address=server.address();if(!address||typeof address==="string")throw new Error("로컬 HTTP 주소를 확인할 수 없습니다.");
    endpoint=`http://127.0.0.1:${address.port}/dispatch`;
  });
  beforeEach(async()=>{
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED","true");vi.stubEnv("PDF_PROGRESS_DISPATCH_ENABLED","true");
    vi.stubEnv("G2B_PDF_EXTRACTION_ENABLED","true");vi.stubEnv("PDF_DISPATCH_REPOSITORY",repository);
    await pool.query(`TRUNCATE ${schema}.notices,${schema}.pdf_dispatch_state CASCADE`);
    await pool.query(`INSERT INTO ${schema}.notices VALUES($1,$2::jsonb)`,[key,JSON.stringify({attachments:files})]);
    calls=[];holdResponses=false;arrived=signal<HttpCall>();
  });
  afterEach(async()=>{
    await Promise.all([...children].map(child=>new Promise<void>(resolve=>{
      child.once("exit",()=>resolve());if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");else resolve();
    })));
    for(const response of heldResponses)response.destroy();heldResponses.clear();
    for(const socket of sockets)socket.destroy();
  });
  afterAll(async()=>{
    vi.unstubAllEnvs();
    try{
      if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      await mkdir("data/pdf-progress-stage3",{recursive:true});
      await writeFile("data/pdf-progress-stage3/crash-recovery.json",JSON.stringify({isolatedTest:true,localHttpOnly:true,scenarios:reports},null,2));
    }finally{try{if(created)await pool.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await pool.end();}}
  });

  it.each([
    {number:1,boundary:"registered",title:"DB 등록 직후",beforeCalls:0},
    {number:2,boundary:"claimed",title:"호출권 확보 후 GitHub 호출 직전",beforeCalls:0},
    {number:3,boundary:"calling",title:"GitHub 요청 수신 후 응답 대기 중",beforeCalls:1},
    {number:4,boundary:"accepted",title:"GitHub 성공 응답 후 DB 확인 직전",beforeCalls:1},
  ])("[$number] $title 강제 종료 후 새 프로세스가 요청 세대를 복구합니다",async scenario=>{
    holdResponses=scenario.boundary==="calling";
    const first=start(scenario.boundary);
    let snapshot:Awaited<ReturnType<typeof state>>,secondId:string|undefined,forced=false;
    try{
      if(scenario.boundary==="calling")await within(arrived.promise);
      else{
        const message=await within(Promise.race([first.message,first.exited.then(()=>{throw new Error("경계 도달 전에 자식 프로세스가 종료되었습니다.");})]));
        expect(message).toMatchObject({type:"held",boundary:scenario.boundary});
        if(scenario.boundary==="accepted")expect(message).toMatchObject({httpStatus:200,runUrl:`https://github.com/${repository}/actions/runs/1`});
      }
      expect(calls).toHaveLength(scenario.beforeCalls);
      if(scenario.boundary==="accepted")secondId=(await queue.enqueue(key,fileNo,2,"automatic")).id;
      snapshot=await state();
      expect(snapshot).toMatchObject({requested_generation:secondId?"2":"1",acknowledged_generation:"0",
        attempt_count:scenario.boundary==="registered"?"0":"1"});
      if(scenario.boundary!=="registered")expect(snapshot).toMatchObject({owner_token:expect.any(String),claimed_generation:"1",last_outcome:"calling",last_http_status:null,last_run_url:null});
    }finally{forced=await kill(first);}
    expect(forced).toBe(true);

    const persisted=await state();expect(persisted).toEqual(snapshot);
    const originalRuns=(await pool.query(`SELECT id FROM ${schema}.attachment_extraction_runs ORDER BY id`)).rows;
    expect(originalRuns).toHaveLength(secondId?2:1);
    if(scenario.boundary!=="registered")await allowRestart();
    holdResponses=false;
    const restarted=start("resume");
    try{
      const message=await within(Promise.race([restarted.message,restarted.exited.then(()=>{throw new Error("복구 결과 없이 자식 프로세스가 종료되었습니다.");})]));
      expect(message).toMatchObject({type:"result",result:{reason:"accepted",attempted:true,generation:secondId?"2":"1",
        runUrl:`https://github.com/${repository}/actions/runs/${scenario.beforeCalls+1}`}});
      expect((await within(restarted.exited))[0]).toBe(0);
    }finally{await kill(restarted);}
    const recovered=await state();
    expect(recovered).toMatchObject({requested_generation:secondId?"2":"1",acknowledged_generation:secondId?"2":"1",owner_token:null,
      claimed_generation:null,last_outcome:"accepted",attempt_count:scenario.boundary==="registered"?"1":"2",
      last_run_url:`https://github.com/${repository}/actions/runs/${scenario.beforeCalls+1}`});
    expect(calls).toHaveLength(scenario.beforeCalls+1);
    expect(calls.every(call=>call.testAuthorization)).toBe(true);
    expect(calls.at(-1)?.body).toEqual({ref:"main",inputs:{mode:"queue-only",invocation:"collection-progress",limit:"50",notice_key:""}});
    if(snapshot.owner_token)expect(calls.at(-1)?.owner).not.toBe(snapshot.owner_token);
    expect((await pool.query(`SELECT id FROM ${schema}.attachment_extraction_runs ORDER BY id`)).rows).toEqual(originalRuns);
    reports.push({boundary:scenario.boundary,requestsBeforeKill:scenario.beforeCalls,requestsAfterRestart:calls.length,
      requestedBefore:snapshot.requested_generation,acknowledgedBefore:snapshot.acknowledged_generation,
      requestedAfter:recovered.requested_generation,acknowledgedAfter:recovered.acknowledged_generation,
      preservedPdfRuns:originalRuns.length,actualKilledProcess:true});
  });
});
