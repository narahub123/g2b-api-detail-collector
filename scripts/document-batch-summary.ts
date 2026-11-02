import { appendFile, readFile } from "node:fs/promises";
import { restoreMaintenance } from "../src/lib/g2b/maintenance";
import { writeMaintenanceSummary } from "../src/lib/g2b/execution-summary";

/** 컨테이너의 배치 결과를 읽어 작업 종류별 집계와 점검 근거를 Actions 요약에 기록합니다. */
async function main(): Promise<void> {
  const text = await readFile(process.argv[2], "utf8");
  for (const line of text.split(/\r?\n/)) {
    let result;
    try { result = JSON.parse(line); } catch { continue; }
    if (result?.operation !== "pdf-extraction-batch") continue;
    const file=process.env.GITHUB_STEP_SUMMARY;
    if(file&&result.byKind){
      const labels={manual:'수동 요청',initial:'신규 문서',reextract:'재추출'};
      const rows=(Object.keys(labels) as Array<keyof typeof labels>).map(kind=>{
        const counts=result.byKind[kind];
        return `| ${labels[kind]} | ${counts.attempts} | ${counts.completed} | ${counts.failed} | ${counts.noText} | ${counts.remainingReady} |`;
      });
      await appendFile(file,`\n### PDF 문서 처리 결과\n\n| 종류 | 처리 시도 | 완료 | 실패 | 텍스트 없음 | 실행 가능 대기 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n`);
    }
    if(result.reason==='g2b_maintenance'){
      const error = restoreMaintenance(result.maintenance);
      if (error) await writeMaintenanceSummary(error.maintenance);
    }
  }
}

main().catch(() => { console.error("PDF 배치 요약을 기록하지 못했습니다."); process.exitCode = 1; });
