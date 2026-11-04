import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfDispatchState } from "./dispatch-state";
import { runPdfDispatch } from "./dispatch";
import { PdfDispatchRuntime } from "./dispatch-runtime";
import { DocumentQueue } from "./queue";
import { DetailQueue } from "../g2b/detail-queue";
import { consumeDetails } from "../g2b/detail-worker";
import { registerNoticeDocumentsInTransaction } from "./registration";
import { testAttachment } from "./test-attachments";

const live=process.env.LIVE_DB_TEST==="1"&&!!process.env.DATABASE_URL;
describe.skipIf(!live)("PDF 실행 요청의 DB 경계",{timeout:120_000},()=>{
  const schema=`pdf_dispatch_${randomUUID().replaceAll("-","")}`;
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:6,connectionTimeoutMillis:10_000});
  const queue=new DocumentQueue(pool,schema),store=new PdfDispatchState(pool,schema);
  const repository="narahub123/g2b-api-detail-collector",key="R26BK10000001--000",fileNo=randomUUID();
  const files=[1,2,3].map(seq=>testAttachment(key,fileNo,seq));
  const accepted={accepted:true,reason:"accepted" as const,httpStatus:204};
  let created=false;
  /** 호출 세대와 간격·소유권을 동일 행에서 읽습니다. */
  async function state(){return (await pool.query(`SELECT * FROM ${schema}.pdf_dispatch_state WHERE repository=$1`,[repository])).rows[0];}
  /** 5분을 실제로 기다리지 않고 격리 스키마의 마지막 시도 시각만 앞당깁니다. */
  async function due(){await pool.query(`UPDATE ${schema}.pdf_dispatch_state SET last_attempt_at=clock_timestamp()-interval '5 minutes' WHERE repository=$1`,[repository]);}
  beforeAll(async()=>{
    await pool.query(`CREATE SCHEMA ${schema}`);created=true;
    for(const name of ["../schema.sql","0006-document-extraction.sql","0008-extraction-diagnostics.sql","0010-single-document-content.sql",
      "0011-stage-timings.sql","0012-extraction-priority.sql","0014-detail-queue.sql","0018-document-registration.sql",
      "0019-attachment-lifecycle.sql","0020-pdf-dispatch.sql","0020-pdf-dispatch.sql"]){
      await pool.query((await readFile(`db/migrations/${name}`,"utf8")).replaceAll("public.",`${schema}.`));
    }
  });
  beforeEach(async()=>{
    vi.stubEnv("DETAIL_PDF_REGISTRATION_ENABLED","true");vi.stubEnv("PDF_PROGRESS_DISPATCH_ENABLED","true");
    vi.stubEnv("G2B_PDF_EXTRACTION_ENABLED","true");vi.stubEnv("PDF_DISPATCH_REPOSITORY",repository);
    await pool.query(`TRUNCATE ${schema}.notices,${schema}.pdf_dispatch_state CASCADE`);
    await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET owner_token=NULL,expires_at=NULL`);
    await pool.query(`UPDATE ${schema}.detail_collection_worker_lease SET owner_token=NULL,expires_at=NULL`);
    await pool.query(`INSERT INTO ${schema}.notices(key,notice_number,notice_order,detail,api) VALUES($1,'R26BK10000001','000',$2::jsonb,'{"bidNtceNo":"R26BK10000001","bidNtceOrd":"000"}')`,[key,JSON.stringify({attachments:files})]);
  });
  afterAll(async()=>{
    vi.unstubAllEnvs();
    try{if(created)await pool.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await pool.end();}
  });

  it("PDF 등록·포인터·실행 요청 세대는 함께 커밋되며 재접수는 세대를 늘리지 않습니다",async()=>{
    await expect(queue.transaction(async db=>{
      await queue.enqueueManyInTransaction(db,key,[files[0]],"automatic");throw new Error("롤백 검사");
    })).rejects.toThrow("롤백 검사");
    expect(await state()).toBeUndefined();expect((await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs`)).rowCount).toBe(0);
    await queue.enqueue(key,fileNo,1,"automatic");expect((await state()).requested_generation).toBe("1");
    await queue.enqueue(key,fileNo,1,"automatic");expect((await state()).requested_generation).toBe("1");
  });

  it("처음은 즉시 호출하고 성공 후 새 세대도 5분 경계까지 기다립니다",async()=>{
    await queue.enqueue(key,fileNo,1,"automatic");const first=await store.claim(repository);expect(first.reason).toBe("claimed");
    if(first.reason!=="claimed")throw new Error("호출권 없음");
    expect(await store.finish(repository,first.token,first.generation,accepted)).toBe(true);
    await queue.enqueue(key,fileNo,2,"automatic");
    await pool.query(`UPDATE ${schema}.pdf_dispatch_state SET last_attempt_at=clock_timestamp()-interval '299 seconds'`);
    expect(await store.claim(repository)).toEqual({reason:"cooldown"});
    await due();expect((await store.claim(repository)).reason).toBe("claimed");expect((await state()).attempt_count).toBe("2");
  });

  it("동시에 호출하는 조정기 중 하나만 외부 요청을 보냅니다",async()=>{
    await queue.enqueue(key,fileNo,1,"automatic");
    let arrived!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{arrived=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>{arrived();await pending;return new Response(null,{status:204});});
    const first=runPdfDispatch(store,{repository,token:"test",fetcher});
    try{
      await entered;
      expect(await runPdfDispatch(new PdfDispatchState(pool,schema),{repository,token:"test",fetcher})).toMatchObject({reason:"in_flight",attempted:false});
      expect(fetcher).toHaveBeenCalledTimes(1);
    }finally{release();await first;}
    expect((await state()).acknowledged_generation).toBe("1");
  });

  it("호출 응답 중 새 PDF가 들어오면 이전 응답은 새 요청 세대를 지우지 않습니다",async()=>{
    await queue.enqueue(key,fileNo,1,"automatic");const first=await store.claim(repository);
    if(first.reason!=="claimed")throw new Error("호출권 없음");
    await queue.enqueue(key,fileNo,2,"automatic");
    await store.finish(repository,first.token,first.generation,accepted);
    expect(await state()).toMatchObject({requested_generation:"2",acknowledged_generation:"1",owner_token:null});
  });

  it("HTTP 거부·연결 실패는 요청을 남기고 실패 시도 사이에도 5분을 적용합니다",async()=>{
    await queue.enqueue(key,fileNo,1,"automatic");
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({secret:"숨긴 본문"},{status:403}));
    expect(await runPdfDispatch(store,{repository,token:"test",fetcher})).toMatchObject({reason:"http_error",attempted:true});
    expect(await state()).toMatchObject({acknowledged_generation:"0",last_http_status:403,attempt_count:"1"});
    expect(await runPdfDispatch(store,{repository,token:"test",fetcher})).toMatchObject({reason:"cooldown",attempted:false});
    expect(fetcher).toHaveBeenCalledTimes(1);await due();
    fetcher.mockRejectedValue(new Error("인증 값은 출력하지 않습니다."));
    expect(await runPdfDispatch(store,{repository,token:"test",fetcher})).toMatchObject({reason:"network_error",attempted:true});
    expect(await state()).toMatchObject({acknowledged_generation:"0",last_http_status:null,attempt_count:"2"});
  });

  it("중단·재시작 후 새 소유권을 얻고 지연된 이전 응답은 최신 세대를 덮어쓰지 않습니다",async()=>{
    await queue.enqueue(key,fileNo,1,"automatic");const first=await store.claim(repository);
    if(first.reason!=="claimed")throw new Error("호출권 없음");
    await queue.enqueue(key,fileNo,2,"automatic");
    await pool.query(`UPDATE ${schema}.pdf_dispatch_state SET lease_expires_at=clock_timestamp()-interval '1 second'`);
    expect(await store.finish(repository,first.token,first.generation,accepted)).toBe(false);
    expect(await store.claim(repository)).toEqual({reason:"cooldown"});await due();
    const second=await new PdfDispatchState(pool,schema).claim(repository);if(second.reason!=="claimed")throw new Error("호출권 없음");
    expect(second.token).not.toBe(first.token);
    expect(await store.finish(repository,first.token,first.generation,accepted)).toBe(false);
    expect(await store.finish(repository,second.token,second.generation,accepted)).toBe(true);
    expect((await state()).acknowledged_generation).toBe("2");
  });

  it("첨부가 모두 삭제되면 실제 준비 대상이 없는 요청은 호출하지 않고 해제합니다",async()=>{
    await queue.enqueue(key,fileNo,1,"automatic");
    await queue.transaction(async db=>{
      await db.query(`UPDATE ${schema}.notices SET detail='{"attachments":[]}'::jsonb WHERE key=$1`,[key]);
      await registerNoticeDocumentsInTransaction(queue,db,key);
    });
    const fetcher=vi.fn<typeof fetch>();expect(await runPdfDispatch(store,{repository,token:"test",fetcher})).toMatchObject({reason:"idle",attempted:false});
    expect(fetcher).not.toHaveBeenCalled();expect(await state()).toMatchObject({acknowledged_generation:"1",attempt_count:"0"});
  });

  it("PDF 작업기가 이미 실행 중이면 중복 호출 없이 다음 점검을 위해 요청을 보존합니다",async()=>{
    await queue.enqueue(key,fileNo,1,"automatic");const token=randomUUID();expect(await queue.acquire(token)).toBe(true);
    expect(await store.claim(repository)).toEqual({reason:"worker_busy"});expect((await state()).attempt_count).toBe("0");
    await queue.release(token);expect((await store.claim(repository)).reason).toBe("claimed");
  });

  it("미래 재시도도 새 세대를 남기고 준비 시각까지 요청을 해제하지 않습니다",async()=>{
    await queue.enqueue(key,fileNo,1,"automatic");const owner=randomUUID();expect(await queue.acquire(owner)).toBe(true);
    const run=(await queue.claim(owner))!;
    await queue.fail(owner,run.id,{code:"network",message:"지연 재시도",retry:true});await queue.release(owner);
    expect(await state()).toMatchObject({requested_generation:"2",acknowledged_generation:"0",attempt_count:"0"});
    expect(await store.claim(repository)).toEqual({reason:"delayed"});
    expect((await state()).acknowledged_generation).toBe("0");
    await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET next_attempt_at=clock_timestamp() WHERE status='queued'`);
    expect((await store.claim(repository)).reason).toBe("claimed");
  });

  it("즉시 대기와 미래 재시도가 섞여 있어도 호출 성공이 미래 요청까지 지우지 않습니다",async()=>{
    await queue.enqueue(key,fileNo,1,"automatic");const owner=randomUUID();await queue.acquire(owner);
    const run=(await queue.claim(owner))!;await queue.fail(owner,run.id,{code:"network",message:"재시도",retry:true});await queue.release(owner);
    await queue.enqueue(key,fileNo,2,"automatic");const claim=await store.claim(repository);
    if(claim.reason!=="claimed")throw new Error("호출권 없음");
    await store.finish(repository,claim.token,claim.generation,accepted);
    expect(await state()).toMatchObject({requested_generation:"3",acknowledged_generation:"0"});
    await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET next_attempt_at=clock_timestamp() WHERE status='queued'`);
    await due();expect((await store.claim(repository)).reason).toBe("claimed");
  });

  it("비활성 상태는 새 스키마 없이 동작하고 마이그레이션 재적용도 기존 세대를 유지합니다",async()=>{
    vi.stubEnv("PDF_PROGRESS_DISPATCH_ENABLED","false");
    await pool.query(`ALTER TABLE ${schema}.pdf_dispatch_state RENAME TO disabled_dispatch_state`);
    try{await queue.enqueue(key,fileNo,1,"automatic");}finally{await pool.query(`ALTER TABLE ${schema}.disabled_dispatch_state RENAME TO pdf_dispatch_state`);}
    expect(await state()).toBeUndefined();vi.stubEnv("PDF_PROGRESS_DISPATCH_ENABLED","true");
    await queue.enqueue(key,fileNo,2,"automatic");const before=await state();
    await pool.query((await readFile("db/migrations/0020-pdf-dispatch.sql","utf8")).replaceAll("public.",`${schema}.`));
    expect(await state()).toEqual(before);
  });

  it("공고별 완료 신호는 전체 수집 종료 전에 호출하고 다음 공고의 요청도 보존합니다",async()=>{
    const secondKey="R26BK10000002--000",secondFile=randomUUID();
    await pool.query(`INSERT INTO ${schema}.notices(key,notice_number,notice_order,api) VALUES($1,'R26BK10000002','000','{"bidNtceNo":"R26BK10000002","bidNtceOrd":"000"}')`,[secondKey]);
    const details=new DetailQueue(pool,schema);
    await details.enqueue({key,jobId:randomUUID(),source:"automatic",purpose:"initial"});
    await details.enqueue({key:secondKey,jobId:randomUUID(),source:"automatic",purpose:"initial"});
    let sent!:()=>void;
    const arrived=new Promise<void>(resolve=>{sent=resolve;});
    let observed:unknown,calledAt:string|undefined;
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>{
      observed=(await pool.query(`SELECT notice_key,status FROM ${schema}.detail_collection_runs ORDER BY notice_key`)).rows;
      calledAt=new Date().toISOString();sent();return new Response(null,{status:204});
    });
    const runtime=new PdfDispatchRuntime(()=>runPdfDispatch(store,{repository,token:"test",fetcher}));runtime.start();
    let count=0;
    try{
      count=await consumeDetails(details,{limit:2,onDetailFinished:()=>runtime.wake(),scrape:async url=>{
        const second=url.includes("R26BK10000002");
        if(second)await arrived;
        return {detail:{sourceUrl:url,links:[],attachments:[second?testAttachment(secondKey,secondFile,1):files[0]]},relatedNoticeKeys:[]};
      }});
      expect(count).toBe(2);expect(observed).toEqual([{notice_key:key,status:"succeeded"},
        {notice_key:secondKey,status:expect.stringMatching(/^(queued|processing)$/)}]);
    }finally{await runtime.finish();}
    expect(fetcher).toHaveBeenCalledTimes(1);expect(await state()).toMatchObject({requested_generation:"2",acknowledged_generation:"1"});
    await mkdir("data/pdf-progress-stage3",{recursive:true});
    await writeFile("data/pdf-progress-stage3/verification.json",JSON.stringify({isolatedTest:true,simulatedGitHubResponse:true,calledAt,
      detailStatesAtCall:observed,finishedDetails:count,attempts:fetcher.mock.calls.length,pendingState:await state()},null,2));
  });
});
