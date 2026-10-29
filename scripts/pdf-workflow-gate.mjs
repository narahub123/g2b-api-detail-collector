import {readFile,appendFile} from 'node:fs/promises';
import {evaluatePdfEvent} from './lib/pdf-automation.mjs';

/** 외부 이벤트 원문은 로그로 남기지 않고 검증된 실행 결정만 출력합니다. */
async function main(){
 const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
 const decision=evaluatePdfEvent({eventName:process.env.GITHUB_EVENT_NAME,ref:process.env.GITHUB_REF,repository:process.env.GITHUB_REPOSITORY,event,enabled:process.env.PDF_AUTOMATION_ENABLED});
 if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`allowed=${decision.allowed}\nmode=${decision.mode}\nlimit=${decision.limit}\nnotice_key=${decision.noticeKey}\nreason=${decision.reason}\n`);
 console.log(JSON.stringify({operation:'pdf-workflow-gate',...decision}));
}
main().catch(()=>{console.error('PDF 워크플로 이벤트를 확인하지 못했습니다.');process.exitCode=1;});
