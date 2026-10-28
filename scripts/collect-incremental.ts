import { runIncrementalCollection } from "../src/lib/g2b/incremental-collection";

/** 명령 인수의 시작·종료 시각을 읽고 증분 수집 결과를 종료 코드에 반영합니다. */
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((value) => {
    const match = /^(--start|--end)=(.+)$/.exec(value);
    if (!match) throw new Error(`알 수 없는 인수: ${value}`);
    return [match[1], match[2]];
  }));
  if (!args["--start"]) throw new Error("--start=ISO시각을 지정하세요.");
  const start = new Date(args["--start"]).toISOString();
  const end = args["--end"] ? new Date(args["--end"]).toISOString()
    : new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const job = await runIncrementalCollection({ start, end });
  console.log(JSON.stringify({ id: job.id, status: job.status, windowStart: job.windowStart,
    windowEnd: job.windowEnd, continuation: job.continuation, apiCount: job.apiCount,
    detailSucceeded: job.detailSucceeded, detailFailed: job.detailFailed, errors: job.errors }));
  if (job.status !== "completed") process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
