import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectionExitCode, writeMaintenanceSummary } from "./execution-summary";
import { G2bMaintenanceError } from "./maintenance";

it("점검 보류만 정상 종료하고 Actions 요약에 근거와 시각을 기록합니다", async () => {
  expect(collectionExitCode("deferred")).toBe(0);
  expect(collectionExitCode("completed")).toBe(0);
  expect(collectionExitCode("failed")).toBe(1);
  expect(collectionExitCode("interrupted")).toBe(1);
  const directory=await mkdtemp(join(tmpdir(),"g2b-summary-"));
  try {
    const file=join(directory,"summary.md");
    await writeMaintenanceSummary(new G2bMaintenanceError("download","2026-11-01T00:00:00Z").maintenance,file);
    expect(await readFile(file,"utf8")).toContain("나라장터 시스템 점검으로 보류");
    expect(await readFile(file,"utf8")).toContain("2026-11-01 09:00:00");
  } finally { await rm(directory,{recursive:true,force:true}); }
});

it("컨테이너 출력의 점검 결과를 호스트 Actions 요약으로 전달합니다",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"g2b-summary-cli-"));
  try {
    const log=join(directory,"result.jsonl"),summary=join(directory,"summary.md");
    await writeFile(log,'일반 로그\n'+JSON.stringify({operation:'pdf-extraction-batch',reason:'g2b_maintenance',maintenance:new G2bMaintenanceError('download').maintenance})+'\n');
    await promisify(execFile)(process.execPath,['--import','tsx','scripts/document-batch-summary.ts',log],{env:{...process.env,GITHUB_STEP_SUMMARY:summary}});
    expect(await readFile(summary,'utf8')).toContain('문서 다운로드 진입 페이지');
  } finally {await rm(directory,{recursive:true,force:true});}
});
