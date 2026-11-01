import { readFile } from "node:fs/promises";
import { restoreMaintenance } from "../src/lib/g2b/maintenance";
import { writeMaintenanceSummary } from "../src/lib/g2b/execution-summary";

/** 컨테이너의 배치 결과만 읽어 호스트의 Actions 요약에 점검 보류를 기록합니다. */
async function main(): Promise<void> {
  const text = await readFile(process.argv[2], "utf8");
  for (const line of text.split(/\r?\n/)) {
    let result;
    try { result = JSON.parse(line); } catch { continue; }
    if (result?.operation !== "pdf-extraction-batch" || result.reason !== "g2b_maintenance") continue;
    const error = restoreMaintenance(result.maintenance);
    if (error) await writeMaintenanceSummary(error.maintenance);
  }
}

main().catch(() => { console.error("PDF 배치의 점검 요약을 기록하지 못했습니다."); process.exitCode = 1; });
