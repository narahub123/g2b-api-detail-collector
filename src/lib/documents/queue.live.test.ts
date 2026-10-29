import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { DocumentQueue } from "./queue";

/** 실제 SQL 경계에서만 오류를 주입해 트랜잭션 전체의 롤백을 확인합니다. */
function failingQueue(pool:pg.Pool,schema:string,pattern:RegExp,afterCommit=false) {
  const wrapped={connect:async()=>{
    const db=await pool.connect();
    return new Proxy(db,{get(target,property){
      if(property==='query')return async(sql:string,params?:unknown[])=>{
        if(pattern.test(sql)){
          if(afterCommit)await db.query(sql,params);
          throw new Error("주입한 DB 오류");
        }
        return db.query(sql,params);
      };
      const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
    }});
  }} as pg.Pool;
  return new DocumentQueue(wrapped,schema);
}

it.skipIf(!process.env.LIVE_DB_TEST || !process.env.DATABASE_URL)("운영 대기열은 동시 접수·임대·원자 재시도·만료 복구·성공 보존을 보장합니다", async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  const schema = `queue_test_${randomUUID().replaceAll("-", "")}`;
  const q = new DocumentQueue(pool, schema);
  const key = "R26BK01797756--001", fileNo = randomUUID();
  const file = (seq: number) => ({name: `공고${seq}.pdf`,url: `/api/attachments/${key}?fileNo=${fileNo}&seq=${seq}`});
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
    await pool.query((await readFile("db/migrations/0006-document-extraction.sql", "utf8")).replaceAll("public.",`${schema}.`));
    await pool.query(`INSERT INTO ${schema}.notices VALUES($1,$2)`,[key,JSON.stringify({attachments:[file(1),file(2)]})]);
    const requests = await Promise.all([q.enqueue(key,fileNo,1,"automatic"),q.enqueue(key,fileNo,1,"manual")]);
    expect(requests[0].id).toBe(requests[1].id);
    expect(requests.map(run=>run.reused).sort()).toEqual([false,true]);
    const second = await q.enqueue(key,fileNo,2,"manual");
    const token = randomUUID(), rival = randomUUID();
    expect(await q.acquire(token)).toBe(true);
    expect(await q.acquire(rival)).toBe(false);
    const run = await q.claim(token);
    expect(run?.id).toBe(requests[0].id);
    await expect(q.complete(rival,run!.id,{pages:[],pageCount:0,characterCount:0,extractorVersion:"test",fileHash:"hash"},null)).rejects.toThrow();
    await q.complete(token,run!.id,{pages:[{pageNumber:1,text:"원문"}],pageCount:1,characterCount:2,extractorVersion:"6.4.299 / reading-order-v1",fileHash:"hash"},null);
    expect((await q.claim(token))?.id).toBe(second.id);
    await q.complete(token,second.id,{pages:[{pageNumber:1,text:"원문"}],pageCount:1,characterCount:2,extractorVersion:"6.4.299 / reading-order-v1",fileHash:"hash"},null);
    const fresh = await q.enqueue(key,fileNo,2,"manual");
    expect((await q.claim(token))?.id).toBe(fresh.id);
    for(const boundary of [/SET status=\$2,error_code/,/INSERT INTO .*attachment_extraction_runs/,/^COMMIT$/]) {
      await expect(failingQueue(pool,schema,boundary).fail(token,fresh.id,{code:"network",message:"일시 오류",retry:true})).rejects.toThrow("주입한");
      expect((await pool.query(`SELECT status FROM ${schema}.attachment_extraction_runs WHERE id=$1`,[fresh.id])).rows[0].status).toBe('processing');
      expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.attachment_extraction_runs WHERE retry_of=$1`,[fresh.id])).rows[0].n).toBe(0);
    }
    await expect(failingQueue(pool,schema,/last_success_run_id=CASE/).complete(token,fresh.id,{pages:[{pageNumber:1,text:"실패한 저장"}],pageCount:1,characterCount:6,extractorVersion:"test",fileHash:"new"},null)).rejects.toThrow("주입한");
    expect((await pool.query(`SELECT last_success_run_id FROM ${schema}.attachment_documents WHERE id=$1`,[fresh.document_id])).rows[0].last_success_run_id).toBe(second.id);
    // 커밋 후 응답이 유실돼도 이미 만든 후속 요청을 복구가 복제하지 않습니다.
    await expect(failingQueue(pool,schema,/^COMMIT$/,true).fail(token,fresh.id,{code:"network",message:"일시 오류",retry:true})).rejects.toThrow("주입한");
    let rows=(await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs WHERE document_id=$1 ORDER BY requested_at,attempt_number`,[fresh.document_id])).rows;
    expect(rows.at(-1).attempt_number).toBe(2);
    expect(rows.at(-1).retry_of).toBe(fresh.id);
    expect((await pool.query(`SELECT last_success_run_id FROM ${schema}.attachment_documents WHERE id=$1`,[fresh.document_id])).rows[0].last_success_run_id).toBe(second.id);
    // 원래 지연 시각을 유지하며 반복 복구로 후속 요청이 늘지 않습니다.
    const retry=rows.at(-1);
    // 이상 상태로 후속 행이 사라져도 원래 종료 시각에 따른 지연으로 한 번만 복구합니다.
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE ${schema}.attachment_documents SET current_run_id=NULL,latest_run_id=$2 WHERE id=$1`,[fresh.document_id,fresh.id]);
      await client.query(`DELETE FROM ${schema}.attachment_extraction_runs WHERE id=$1`,[retry.id]);
      await client.query('COMMIT');
    } finally {client.release();}
    await q.recover(token); await q.recover(token);
    const restored=(await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs WHERE retry_of=$1`,[fresh.id])).rows;
    expect(restored).toHaveLength(1);expect(restored[0].next_attempt_at).toEqual(retry.next_attempt_at);retry.id=restored[0].id;
    await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,[retry.id]);
    expect((await q.claim(token))?.id).toBe(retry.id);
    // 이전 소유자의 늦은 저장은 새 소유자의 결과를 덮어쓰지 못합니다.
    await pool.query(`UPDATE ${schema}.attachment_extraction_worker_lease SET expires_at=now()-interval '1 second'`);
    expect(await q.acquire(rival)).toBe(true);
    await q.recover(rival);
    await expect(q.fail(token,retry.id,{code:"network",message:"늦음",retry:true})).rejects.toThrow();
    rows=(await pool.query(`SELECT * FROM ${schema}.attachment_extraction_runs WHERE chain_id=$1 ORDER BY attempt_number`,[fresh.id])).rows;
    expect(rows.map(r=>r.status)).toEqual(["failed","interrupted","queued"]);
    await pool.query(`UPDATE ${schema}.attachment_extraction_runs SET next_attempt_at=now()-interval '1 second' WHERE id=$1`,[rows[2].id]);
    expect((await q.claim(rival))?.id).toBe(rows[2].id);
    await q.fail(rival,rows[2].id,{code:"network",message:"소진",retry:true});
    await q.recover(rival);
    expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.attachment_extraction_runs WHERE chain_id=$1`,[fresh.id])).rows[0].n).toBe(3);
    const empty=await q.enqueue(key,fileNo,2,'manual');await q.claim(rival);
    await q.complete(rival,empty.id,{pages:[{pageNumber:1,text:''}],pageCount:1,characterCount:0,extractorVersion:"test",fileHash:'empty'},null);
    expect((await pool.query(`SELECT last_success_run_id FROM ${schema}.attachment_documents WHERE id=$1`,[fresh.document_id])).rows[0].last_success_run_id).toBe(second.id);
    const older=await q.enqueue(key,fileNo,2,'manual');await q.claim(rival);
    await q.fail(rival,older.id,{code:'network',message:'오류',retry:true});
    const client2=await pool.connect();
    try {
      await client2.query('BEGIN');
      await client2.query(`UPDATE ${schema}.attachment_documents SET current_run_id=NULL,latest_run_id=$2 WHERE id=$1`,[fresh.document_id,older.id]);
      await client2.query(`DELETE FROM ${schema}.attachment_extraction_runs WHERE retry_of=$1`,[older.id]);
      await client2.query('COMMIT');
    } finally {client2.release();}
    const newer=await q.enqueue(key,fileNo,2,'manual');
    await Promise.all([q.recover(rival),q.recover(rival)]);
    expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.attachment_extraction_runs WHERE chain_id=$1`,[older.id])).rows[0].n).toBe(1);
    expect((await q.enqueue(key,fileNo,1,'automatic')).id).toBe(requests[0].id);
    await pool.query(`UPDATE ${schema}.notices SET detail=$2 WHERE key=$1`,[key,JSON.stringify({attachments:[{...file(2),name:'이름변경.pdf'}]})]);
    await q.discover(key);
    expect((await pool.query(`SELECT is_current FROM ${schema}.attachment_documents WHERE notice_key=$1 AND seq=1`,[key])).rows[0].is_current).toBe(false);
    expect((await pool.query(`SELECT filename FROM ${schema}.attachment_documents WHERE id=$1`,[fresh.document_id])).rows[0].filename).toBe('이름변경.pdf');
    await expect(q.enqueue(key,fileNo,1,'manual')).rejects.toThrow('직접 첨부');
    expect((await q.claim(rival,true))?.id).toBe(newer.id);
    await q.deferClaim(rival,newer.id);
    expect((await q.claim(rival,true))?.id).toBe(newer.id);
    await q.complete(rival,newer.id,{pages:[],pageCount:0,characterCount:0,extractorVersion:"test",fileHash:'empty'},null);
    await pool.query(`UPDATE ${schema}.notices SET detail=$2 WHERE key=$1`,[key,JSON.stringify({attachments:[file(2),file(3)]})]);
    const auto=await q.enqueue(key,fileNo,3,'automatic');
    expect(await q.claim(rival,true)).toBeNull();
    expect((await q.claim(rival,false))?.id).toBe(auto.id);
    const during=await q.enqueue(key,fileNo,3,'manual');
    expect(during.id).toBe(auto.id);expect(during.source).toBe('automatic');
    await q.fail(rival,auto.id,{code:'invalid_pdf',message:'손상',retry:false});
    await q.release(rival);
    expect(await q.renew(token)).toBe(false);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end();
  }
},120000);
