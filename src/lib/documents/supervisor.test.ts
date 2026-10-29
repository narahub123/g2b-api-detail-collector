import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseExtraction } from "./supervisor";
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
  it("시간 초과로 멈춘 프로세스를 종료하고 임시 경로를 지웁니다", async () => {
    const before = (await readdir(tmpdir())).filter(name => name.startsWith("g2b-pdf-worker-"));
    const path = await script("setInterval(()=>{},1000);");
    await expect(superviseExtraction("id", "key", new AbortController().signal, { script: path, timeoutMs: 800 })).rejects.toThrow("시간");
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
