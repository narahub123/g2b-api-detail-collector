import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_BYTES, RUN_TIMEOUT_MS } from "./contract";
import type { PdfResult } from "./contract";
import {ExtractionError,isExtractionProgress} from './diagnostics';
import type {DiagnosticError,ExtractionProgress} from './diagnostics';

/** 다운로드 임시 디렉터리의 크기를 합산해 완료 전에도 과대 파일을 중단합니다. */
async function directoryBytes(path: string): Promise<number> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch { return 0; }
  let bytes = 0;
  for (const entry of entries) {
    const file = join(path, entry.name);
    try { bytes += entry.isDirectory() ? await directoryBytes(file) : (await stat(file)).size; } catch { /* 브라우저가 정리한 파일은 제외합니다. */ }
  }
  return bytes;
}

/** 파서가 멈춰도 브라우저 자식 프로세스까지 강제 종료하고 임시 자료를 정리합니다. */
export async function superviseExtraction(id: string, key: string, signal: AbortSignal,
  options: { timeoutMs?: number; script?: string; maxBytes?: number; ownerToken?: string; onProgress?:(value:ExtractionProgress)=>void } = {}): Promise<{ result: PdfResult; peakMemory: number | null }> {
  const directory = await mkdtemp(join(tmpdir(), "g2b-pdf-worker-"));
  const child = spawn(process.execPath, ["--import", "tsx", options.script ?? resolve("scripts/document-extract.ts"), id, key, directory],
    { detached: process.platform !== "win32", stdio: ['ignore','ignore','ignore','ipc'], env: { ...process.env, PDF_EXTRACTION_OWNER_TOKEN: options.ownerToken, TMPDIR: directory, TEMP: directory, TMP: directory } });
  child.on('message',(message:unknown)=>{
    if(message&&typeof message==='object'&&'type' in message&&message.type==='progress'&&'progress' in message&&isExtractionProgress(message.progress))options.onProgress?.(message.progress);
  });
  let failure: string | null = null;
  let peakMemory: number | null = null;
  let inspecting = false;
  const descendants = new Map<number, string>();
  /** 분리된 Chrome 프로세스도 시작 시각과 함께 추적해 PID 재사용을 구분합니다. */
  const track = (pid: number) => {
    if (process.platform !== "linux") return;
    try {
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
      for (const descendant of children) {
        const info = readFileSync(`/proc/${descendant}/stat`, "utf8");
        descendants.set(descendant, info.slice(info.lastIndexOf(")") + 2).split(" ")[19]);
        track(descendant);
      }
    } catch { /* 검사 중 종료한 프로세스는 제외합니다. */ }
  };
  /** 독립 프로세스 그룹을 종료해 Chrome이 부모 종료 뒤에 남지 않게 합니다. */
  const kill = () => {
    if (child.pid) track(child.pid);
    for (const [pid, birth] of [...descendants].reverse()) {
      try {
        const info = readFileSync(`/proc/${pid}/stat`, "utf8");
        if (info.slice(info.lastIndexOf(")") + 2).split(" ")[19] === birth) process.kill(pid, "SIGKILL");
      } catch { /* 이미 종료한 자식은 제외합니다. */ }
    }
    try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* 이미 종료한 프로세스는 무시합니다. */ }
  };
  /** 최초 중단 사유를 유지하고 실행 자원을 종료합니다. */
  const stop = (message: string) => { failure ??= message; kill(); };
  const abort = () => stop("작업 서비스 종료로 추출이 중단되었습니다.");
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("PDF 처리 시간이 5분 제한을 초과했습니다."), options.timeoutMs ?? RUN_TIMEOUT_MS);
  const monitor = setInterval(async () => {
    if (inspecting) return;
    inspecting = true;
    try {
      if (child.pid) track(child.pid);
      if (await directoryBytes(join(directory, "downloads")) > (options.maxBytes ?? MAX_BYTES)) stop("다운로드가 50MiB 제한을 초과했습니다.");
      const value = Number(await readFile("/sys/fs/cgroup/memory.current", "utf8").catch(() => "NaN"));
      if (Number.isFinite(value)) peakMemory = Math.max(peakMemory ?? 0, value);
    } finally { inspecting = false; }
  }, 200);
  try {
    if (signal.aborted) abort();
    const [code,exitSignal] = await new Promise<[number | null,NodeJS.Signals|null]>((accept, reject) => {
      child.once("error", reject); child.once("exit", (code,signal)=>accept([code,signal]));
    });
    if (failure) throw new ExtractionError(/시간/.test(failure)?'time_limit':/크기|50MiB/.test(failure)?'size_limit':'process_exit',failure,{exitCode:code,signal:exitSignal});
    if (code !== 0) {
      const saved = await readFile(join(directory, "error.json"), "utf8").then(value => JSON.parse(value) as {error:string;diagnostic?:DiagnosticError}).catch(() => null);
      const error=new ExtractionError(saved?'child_error':'process_exit',saved?.error??'PDF 작업 프로세스가 종료되었습니다.',{exitCode:code,signal:exitSignal});
      if(saved?.diagnostic)error.diagnostic={...saved.diagnostic,exitCode:code,signal:exitSignal};
      throw error;
    }
    const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8")) as PdfResult;
    return { result, peakMemory };
  } finally {
    clearTimeout(timer); clearInterval(monitor); signal.removeEventListener("abort", abort);
    kill();
    await rm(directory, { recursive: true, force: true });
  }
}
