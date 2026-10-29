export const PDF_DEFAULT_BRANCH='main';
const modes=new Set(['discover-and-drain','queue-only']);
const invocations=new Set(['manual','watchdog']);

/** 신뢰하는 기본 브랜치 이벤트와 제한된 입력만 PDF 배치로 전달합니다. */
export function evaluatePdfEvent({eventName,ref,repository,event,enabled}){
 const deny=reason=>({allowed:false,reason,mode:'queue-only',limit:20,noticeKey:''});
 if(typeof repository!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(repository)||event?.repository?.full_name!==repository||event?.repository?.default_branch!==PDF_DEFAULT_BRANCH||ref!==`refs/heads/${PDF_DEFAULT_BRANCH}`)return deny('untrusted_ref');
 if(eventName==='workflow_run'){
  const run=event.workflow_run;
  if(event.action!=='completed'||run?.status!=='completed'||run?.name!=='G2B collection'||run?.path!=='.github/workflows/collect.yml'||run?.event!=='workflow_dispatch'||run?.head_branch!==PDF_DEFAULT_BRANCH||run?.head_repository?.full_name!==repository||!['success','failure','cancelled','timed_out'].includes(run?.conclusion))return deny('untrusted_collection');
  if(enabled!=='true')return deny('disabled');
  return {allowed:true,reason:'collection_completed',mode:'discover-and-drain',limit:20,noticeKey:''};
 }
 if(eventName!=='workflow_dispatch')return deny('unsupported_event');
 const inputs=event.inputs??{},mode=inputs.mode??'discover-and-drain',invocation=inputs.invocation??'manual';
 if(!modes.has(mode)||!invocations.has(invocation))return deny('invalid_input');
 const rawLimit=String(inputs.limit??'20'),noticeKey=inputs.notice_key??'';
 if(!/^(?:[1-9]|1[0-9]|20)$/.test(rawLimit)||typeof noticeKey!=='string'||noticeKey.length>200||(noticeKey&&(!/^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$/.test(noticeKey)||noticeKey.includes('..'))))return deny('invalid_input');
 if(invocation==='watchdog'){
  if(mode!=='queue-only'||rawLimit!=='20'||noticeKey)return deny('invalid_input');
  if(enabled!=='true')return deny('disabled');
 }
 return {allowed:true,reason:invocation,mode,limit:Number(rawLimit),noticeKey};
}

/** 기존 수집 작업과 별개인 비활성 보완 작업을 만들며 인증은 헤더에만 넣습니다. */
export function makeWatchdogJob(repository,token){
 if(!/^[-\w.]+\/[-\w.]+$/.test(repository)||typeof token!=='string'||!token||/[\r\n]/.test(token))throw new Error('PDF 보완 실행 설정을 확인하세요.');
 return {job:{title:'G2B PDF queue watchdog',enabled:false,saveResponses:false,
  url:`https://api.github.com/repos/${repository}/actions/workflows/pdf-extract.yml/dispatches`,requestMethod:1,requestTimeout:30,redirectSuccess:false,
  schedule:{timezone:'Asia/Seoul',expiresAt:0,hours:[-1],mdays:[-1],months:[-1],wdays:[-1],minutes:[0,10,20,30,40,50]},
  extendedData:{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2026-03-10'},body:JSON.stringify({ref:PDF_DEFAULT_BRANCH,inputs:{mode:'queue-only',invocation:'watchdog'}})}}};
}

/** 외부 오류의 본문·헤더를 출력하지 않고 고정된 API에만 요청합니다. */
async function externalJson(fetcher,url,init={}){
 const response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error(`외부 설정 API가 요청을 거부했습니다 (${response.status}).`);
 return response.json();
}
/** 응답의 키 순서에 영향받지 않게 비활성·호출 본문·간격·인증 설정을 비교합니다. */
function matchingDisabledJob(actual,expected){
 if(!actual||actual.enabled!==false)return false;
 const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
 for(const key of ['title','enabled','saveResponses','url','requestMethod','requestTimeout','redirectSuccess'])if(actual[key]!==expected[key])return false;
 for(const key of Object.keys(expected.schedule))if(canonical(actual.schedule?.[key])!==canonical(expected.schedule[key]))return false;
 try{
  if(canonical(JSON.parse(actual.extendedData?.body))!==canonical(JSON.parse(expected.extendedData.body)))return false;
  const headers=value=>Object.fromEntries(Object.entries(value??{}).map(([key,item])=>[key.toLowerCase(),item]));
  return canonical(headers(actual.extendedData?.headers))===canonical(headers(expected.extendedData.headers));
 }catch{return false;}
}
/** 기본 브랜치 적용을 확인한 뒤 PDF 전용 작업만 중복 없이 비활성 등록합니다. */
export async function registerDisabledWatchdog({repository,githubToken,cronKey,fetcher=fetch}){
 const configuration=makeWatchdogJob(repository,githubToken);
 if(!cronKey||/[\r\n]/.test(cronKey))throw new Error('cron-job.org API 키를 확인하세요.');
 const githubHeaders={Authorization:`Bearer ${githubToken}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'};
 const repo=await externalJson(fetcher,`https://api.github.com/repos/${repository}`,{headers:githubHeaders});
 if(repo.default_branch!==PDF_DEFAULT_BRANCH)throw new Error('기본 브랜치를 먼저 확인하세요.');
 const workflow=await externalJson(fetcher,`https://api.github.com/repos/${repository}/actions/workflows/pdf-extract.yml`,{headers:githubHeaders});
 if(workflow.path!=='.github/workflows/pdf-extract.yml'||workflow.state!=='active')throw new Error('PDF 워크플로를 기본 브랜치에 먼저 적용하세요.');
 const cronHeaders={Authorization:`Bearer ${cronKey}`,'Content-Type':'application/json'};
 const listing=await externalJson(fetcher,'https://api.cron-job.org/jobs',{headers:cronHeaders});
 if(!Array.isArray(listing.jobs)||listing.someFailed)throw new Error('기존 cron 작업 목록을 확인하지 못했습니다.');
 const matching=listing.jobs.filter(job=>job.url===configuration.job.url);
 if(matching.length>1||(matching.length===1&&matching[0].title!==configuration.job.title))throw new Error('같은 호출 주소의 기존 작업을 확인하세요.');
 if(matching.length){
  const details=await externalJson(fetcher,`https://api.cron-job.org/jobs/${matching[0].jobId}`,{headers:cronHeaders});
  if(!matchingDisabledJob(details.jobDetails,configuration.job))throw new Error('기존 PDF 보완 작업의 비활성·간격·인증·호출 설정을 확인하세요.');
  return {jobId:matching[0].jobId,created:false,enabled:false};
 }
 const result=await externalJson(fetcher,'https://api.cron-job.org/jobs',{method:'PUT',headers:cronHeaders,body:JSON.stringify(configuration)});
 if(!Number.isSafeInteger(result.jobId)||result.jobId<=0)throw new Error('보완 작업 등록 결과를 확인하지 못했습니다.');
 return {jobId:result.jobId,created:true,enabled:false};
}
