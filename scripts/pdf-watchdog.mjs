import {makeWatchdogJob,registerDisabledWatchdog} from './lib/pdf-automation.mjs';

/** 기본 출력은 비밀값 없는 검토용 설정이며 명시적 등록도 비활성 작업만 만듭니다. */
async function main(){
 const args=process.argv.slice(2);
 if(args.length>1||(args[0]&&args[0]!=='--register'))throw new Error('지원하지 않는 보완 실행 명령입니다.');
 const repository='narahub123/g2b-api-detail-collector';
 if(!args.length){console.log(JSON.stringify(makeWatchdogJob(repository,'<PDF_GITHUB_TOKEN>'),null,2));return;}
 const result=await registerDisabledWatchdog({repository,githubToken:process.env.PDF_GITHUB_TOKEN,cronKey:process.env.CRON_JOB_API_KEY});
 console.log(JSON.stringify({operation:'pdf-watchdog-registration',...result}));
}
main().catch(()=>{console.error('PDF 보완 작업을 등록하지 못했습니다. 기본 브랜치 적용·API 권한과 설정을 확인하세요.');process.exitCode=1;});
