import {appendFile,readFile} from 'node:fs/promises';
import {restoreMaintenance} from '../src/lib/g2b/maintenance';
import {writeMaintenanceSummary} from '../src/lib/g2b/execution-summary';
import {sanitizeDiagnostic} from '../src/lib/documents/diagnostics';
import {PROBE_NOTE} from '../src/lib/documents/connection-probe';

/** 로그 문자열을 정제하고 요약 표와 HTML 경계를 보호합니다. */
function cell(value:unknown):string{
 return sanitizeDiagnostic(typeof value==='string'?value:String(value??'-'),2000).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','\\|').replace(/[\r\n]/g,' ');
}
/** 객체가 아닌 JSON 값은 제외하고 다른 줄의 처리를 계속합니다. */
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}

/** 배치 실패나 로그 손상에도 유효한 진단만 요약하며 원래 종료 결과를 유지합니다. */
async function main():Promise<void>{
 let source='',incomplete=false,final=false;
 try{source=await readFile(process.argv[2],'utf8');}catch{incomplete=true;}
 const output:string[]=[];
 for(const line of source.split(/\r?\n/)){
  if(!line.trim())continue;
  let result:unknown;
  try{result=JSON.parse(line);}catch{if(line.trimStart().startsWith('{'))incomplete=true;continue;}
  if(!object(result))continue;
  if(result.operation==='pdf-connection-diagnostic'){
   const valid=['dns','tcp','tls'].includes(String(result.phase))&&[4,6].includes(Number(result.family))&&
    ['completed','failed','stage_timeout','overall_timeout','cancelled','skipped'].includes(String(result.outcome))&&
    typeof result.runId==='string'&&typeof result.at==='string'&&Number.isFinite(Date.parse(result.at))&&
    typeof result.elapsedMs==='number'&&Number.isFinite(result.elapsedMs)&&result.elapsedMs>=0;
   if(!valid){incomplete=true;continue;}
   const addresses=Array.isArray(result.addresses)?result.addresses.filter(v=>typeof v==='string').map(cell).join(', '):'-';
   const labels={completed:'성공',failed:'실패',stage_timeout:'검사별 시간 초과',overall_timeout:'전체 시간 초과',cancelled:'취소',skipped:'생략'};
   output.push(`\n### PDF 실패 후 연결 검사\n\n${PROBE_NOTE}\n\n원래 요청의 접속 IP: 이 별도 검사에서 판단하지 않음. DNS 조회 방식은 원래 요청과 다를 수 있습니다.\n\n`+
    `| 실행 ID | 검사 시각 | 단계 | 주소군 | 결과 | 소요 시간(ms) |\n| --- | --- | --- | --- | --- | ---: |\n`+
    `| ${cell(result.runId)} | ${cell(result.at)} | ${cell(result.phase)} | IPv${cell(result.family)} | ${labels[result.outcome as keyof typeof labels]} | ${cell(result.elapsedMs)} |\n`+
    `\n대상 호스트: www.g2b.go.kr:443 · 실패 후 DNS 조회 주소: ${addresses} · 별도 검사 대상 IP: ${cell(result.address)}\n`);
   if(object(result.diagnostic)&&typeof result.diagnostic.message==='string')output.push(`\n검사 오류: ${cell(result.diagnostic.message)}\n`);
   continue;
  }
  if(result.operation!=='pdf-extraction-batch')continue;
  if(!object(result.byKind)){incomplete=true;}else{
   const labels={manual:'수동 요청',initial:'신규 문서',reextract:'재추출'},rows:string[]=[];
   let complete=true;
   for(const kind of Object.keys(labels) as Array<keyof typeof labels>){
    const counts=result.byKind[kind];
    if(!object(counts)||!['attempts','completed','failed','noText','remainingReady'].every(key=>Number.isSafeInteger(counts[key])&&Number(counts[key])>=0)){
     incomplete=true;complete=false;continue;
    }
    rows.push(`| ${labels[kind]} | ${counts.attempts} | ${counts.completed} | ${counts.failed} | ${counts.noText} | ${counts.remainingReady} |`);
   }
   final ||= complete;
   if(rows.length)output.push(`\n### PDF 문서 처리 결과\n\n| 종류 | 처리 시도 | 완료 | 실패 | 텍스트 없음 | 실행 가능 대기 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n`);
  }
  if(result.reason==='g2b_maintenance'){
   const error=restoreMaintenance(result.maintenance);
   if(error)try{await writeMaintenanceSummary(error.maintenance);}catch{console.warn('PDF 요약 경고: 점검 안내를 기록하지 못했습니다.');}
  }
 }
 if(incomplete||!final)output.push('\n진단 기록 불완전: 로그 누락·손상 또는 최종 집계 부재로 전체 실행 결과를 확인할 수 없습니다.\n');
 const file=process.env.GITHUB_STEP_SUMMARY;
 if(file)await appendFile(file,output.join(''));
}

main().catch(()=>{console.warn('PDF 요약 경고: 요약을 기록하지 못했습니다. 원래 배치 결과는 유지합니다.');});
