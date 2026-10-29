import {readFile} from 'node:fs/promises';
import type pg from 'pg';

/** 추가 이관 검증·백업 없이 PoC 테이블 삭제만 트랜잭션으로 수행합니다. */
export async function retirePdfPoc(pool:pg.Pool,schema=process.env.G2B_DB_SCHEMA||'public'){
 if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('DB 스키마 이름이 올바르지 않습니다.');
 const sql=(await readFile(new URL('../../../db/migrations/0007-retire-pdf-poc.sql',import.meta.url),'utf8')).replaceAll('public.',schema+'.');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='5s'");await db.query("SET LOCAL statement_timeout='15s'");
  await db.query(sql);await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
}
