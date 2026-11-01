import { expect, it, vi } from "vitest";
import type pg from "pg";
import { DocumentQueue } from "./queue";
import { G2bMaintenanceError } from "../g2b/maintenance";

it("점검 반환은 같은 실행과 시도를 유지하고 선점 시 보류 안내를 해제합니다", async () => {
  const query=vi.fn(async(sql:string,_params?:unknown[])=>{
    if(sql.includes(' valid FROM')) return {rows:[{valid:true}]};
    if(sql.includes('SELECT d.*')) return {rows:[{id:'doc',current_run_id:'run',active_chain_id:'chain',notice_key:'key'}]};
    if(sql.includes('SELECT * FROM')) return {rows:[{id:'run',status:'processing',owner_token:'owner',chain_id:'chain'}]};
    if(sql.includes("SET status='processing'")) return {rows:[{id:'run',attempt_number:2}]};
    return {rows:[]};
  });
  const release=vi.fn(),queue=new DocumentQueue({connect:async()=>({query,release})} as unknown as pg.Pool);
  const info=new G2bMaintenanceError('download').maintenance;
  await queue.deferClaim('owner','run',info);
  const update=query.mock.calls.find(([sql])=>sql.includes("SET status='queued'"))!;
  expect(update[0]).not.toContain('attempt_number=');
  expect(update[1]).toEqual(['run','g2b_maintenance',info.message]);
  expect(query.mock.calls.some(([sql])=>sql.includes('INSERT'))).toBe(false);
  await queue.claim('owner');
  expect(query.mock.calls.find(([sql])=>sql.includes("SET status='processing'"))?.[0]).toContain('error_code=NULL');
  expect(release).toHaveBeenCalledTimes(2);
});
