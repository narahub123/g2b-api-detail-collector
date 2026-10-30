import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fetchServiceNotices} from '../src/lib/g2b/api-client';
import {parsePostedDateRange} from '../src/lib/g2b/date-range';
import {prepareTargets,validateManifest,runSample} from '../src/lib/g2b/collection-benchmark';
import {withMeasurement,measure,measureSync,type TimingEvent} from '../src/lib/g2b/collection-performance';
import {scrapeDetailPage,serviceDetailUrl} from '../src/lib/g2b/detail-page';
import {structureNoticeDetail} from '../src/lib/g2b/structured-data';

/** 인수를 명시적으로 검증하고 준비와 실제 상세 측정을 분리합니다. */
async function main(){
 const args=new Map<string,string>();
 for(const arg of process.argv.slice(2)){
  if(arg==='--prepare'){if(args.has('prepare'))throw Error('중복 인수');args.set('prepare','true');continue;}
  const match=/^--(start|end|manifest|iterations|out)=(.+)$/.exec(arg);
  if(!match||args.has(match[1]))throw Error('인수를 확인하세요.');args.set(match[1],match[2]);
 }
 const output=args.get('out');if(!output)throw Error('--out을 지정하세요.');
 const dir=resolve(output),prepare=args.has('prepare');
 const iterations=Number(args.get('iterations')??3);
 if(!Number.isSafeInteger(iterations)||iterations<1||iterations>3)throw Error('반복 횟수는 1~3입니다.');
 if(prepare){
  if(args.has('manifest')||args.has('iterations'))throw Error('준비 인수를 확인하세요.');
  const range=parsePostedDateRange(args.get('start')??'',args.get('end')??'');
  await mkdir(dirname(dir),{recursive:true});await mkdir(dir,{recursive:false});
  const keys=await prepareTargets(fetchServiceNotices(range));
  await writeFile(join(dir,'manifest.json'),JSON.stringify({version:1,keys,range},null,2),{flag:'wx'});
  console.log(`대상 ${keys.length}건 준비 완료: ${dir}`);return;
 }
 if(args.has('start')||args.has('end')||!args.has('manifest'))throw Error('--manifest로 대상을 지정하세요.');
 const manifest=validateManifest(JSON.parse(await readFile(resolve(args.get('manifest')!),'utf8')));
 await mkdir(dirname(dir),{recursive:true});await mkdir(dir,{recursive:false});
 let revision='unknown';try{revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{/* Git이 없는 환경도 실행 정보를 남깁니다. */}
 for(let iteration=1;iteration<=iterations;iteration++){
  const target=join(dir,`iteration-${iteration}`);await mkdir(target);
  const events:TimingEvent[]=[];let dropped=0;const runId=randomUUID(),start=performance.now();
  const rows=await runSample(manifest.keys,key=>withMeasurement({runId,key,attempt:iteration,sink:event=>{
   // 긴 실행에서도 측정 기록이 무한히 메모리를 차지하지 않도록 제한합니다.
   if(events.length<100000)events.push(event);else dropped++;
  }},()=>measure('notice',async()=>{
   const [number,order]=key.split('--').map(decodeURIComponent);
   const result=await measure('detail.scrape',()=>scrapeDetailPage(serviceDetailUrl(number,order)));
   const structured=measureSync('detail.structure',()=>structureNoticeDetail(key,result.detail));
   return {result,structured};
  })));
  const durationMs=performance.now()-start;
  const groups=Object.entries(Object.groupBy(events,event=>event.operation)).map(([operation,items])=>({operation,count:items!.length,totalInclusiveMs:items!.reduce((sum,item)=>sum+item.durationMs,0)}));
  const summary={runId,iteration,revision,node:process.version,manifest,durationMs,dropped,complete:rows.every(row=>row.status==='succeeded'),results:rows.map(({key,status})=>({key,status})),groups};
  // 원시 측정 파일 출력 실패는 이미 끝난 수집을 다시 실행시키지 않습니다.
  let outputFailed=false;
  try{await writeFile(join(target,'events.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\n',{flag:'wx'});}catch{outputFailed=true;}
  await writeFile(join(target,'summary.json'),JSON.stringify({...summary,outputFailed},null,2),{flag:'wx'});
  await writeFile(join(target,'snapshot.json'),JSON.stringify(rows,null,2),{flag:'wx'});
  await writeFile(join(target,'report.md'),`# 상세 수집 측정 ${iteration}\n\n실행: ${runId}\n\n전체: ${durationMs.toFixed(1)}ms · 누락: ${dropped} · 원시 기록 출력 실패: ${outputFailed}\n\n관련 공고 추가 수집 및 DB 저장은 실행하지 않았습니다. 단계 시간은 중첩 inclusive 값이므로 서로 합산하지 마세요. attachment.response는 비동기 응답 파싱 시간으로 다른 구간과 겹칠 수 있습니다.\n\n| 작업 | 횟수 | 누적 inclusive ms |\n|---|---:|---:|\n${groups.map(group=>`| ${group.operation} | ${group.count} | ${group.totalInclusiveMs.toFixed(1)} |`).join('\n')}\n`,{flag:'wx'});
  if(!summary.complete||dropped||outputFailed)process.exitCode=1;
  console.log(`측정 ${iteration}/${iterations} 완료: ${target}`);
 }
}

main().catch(()=>{console.error('측정을 완료하지 못했습니다. 인수·출력 경로·인증 설정·네트워크를 확인하세요. 미완료 반복은 비교에서 제외하세요.');process.exitCode=1;});
