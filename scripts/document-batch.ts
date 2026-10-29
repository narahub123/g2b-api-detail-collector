import { chromium } from "playwright-core";
import { getDocumentPool } from "../src/lib/documents/pool";
import { DocumentQueue } from "../src/lib/documents/queue";
import { runBatch } from "../src/lib/documents/worker";

/** 정해진 인자만 받아 자동 발견 또는 대기열 전용 배치를 실행합니다. */
async function main(){
  const args=process.argv.slice(2),options:Record<string,string>={};let queueOnly=false;
  for(const arg of args){
    if(arg==='--queue-only'){queueOnly=true;continue;}
    const match=/^--(limit|budget-minutes|notice-key)=(.+)$/.exec(arg);
    if(!match || options[match[1]]!==undefined)throw new Error("PDF 배치 인자가 올바르지 않습니다.");options[match[1]]=match[2];
  }
  process.env.G2B_CHROME_PATH ||= chromium.executablePath();
  const store=new DocumentQueue(getDocumentPool()),abort=new AbortController();
  const stop=()=>abort.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try {
    const result=await runBatch(store,{mode:"cloud",limit:options.limit?Number(options.limit):20,
      budgetMinutes:options['budget-minutes']?Number(options['budget-minutes']):50,noticeKey:options['notice-key'],
      signal:abort.signal,discover:!queueOnly});
    console.log(JSON.stringify({operation:"pdf-extraction-batch",...result}));
  } finally {process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
}
main().catch(()=>{console.error(JSON.stringify({operation:"pdf-extraction-batch",error:"배치가 실패했습니다. 설정과 대기열 상태를 확인하세요."}));process.exitCode=1;}).finally(()=>getDocumentPool().end());
