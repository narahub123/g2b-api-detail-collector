import {expect,it,vi} from 'vitest';
import {registerDisabledWatchdog,makeWatchdogJob} from '../../../scripts/lib/pdf-automation.mjs';
it('기본 브랜치에 PDF 워크플로가 없으면 cron 작업을 만들지 않습니다',async()=>{
 const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/actions/workflows/pdf-extract.yml')?Response.json({}, {status:404}):Response.json({default_branch:'main'}));
 await expect(registerDisabledWatchdog({repository:'owner/repo',githubToken:'github-secret',cronKey:'cron-secret',fetcher})).rejects.toThrow();
 expect(fetcher.mock.calls.some(([url])=>String(url).includes('cron-job.org'))).toBe(false);
});
it('기존 PDF 전용 작업은 재사용하고 기존 수집 작업은 변경하지 않습니다',async()=>{
 const fetcher=vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);
  if(url==='https://api.cron-job.org/jobs/2')return Response.json({jobDetails:makeWatchdogJob('owner/repo','secret').job});
  if(url.endsWith('/actions/workflows/pdf-extract.yml'))return Response.json({path:'.github/workflows/pdf-extract.yml',state:'active'});
  if(url==='https://api.cron-job.org/jobs')return Response.json({jobs:[{jobId:1,title:'collection',url:'https://other.test'},{jobId:2,title:'G2B PDF queue watchdog',url:'https://api.github.com/repos/owner/repo/actions/workflows/pdf-extract.yml/dispatches',enabled:false}]});
  return Response.json({default_branch:'main'});
 });
 expect(await registerDisabledWatchdog({repository:'owner/repo',githubToken:'secret',cronKey:'key',fetcher})).toMatchObject({jobId:2,created:false});
 expect(fetcher.mock.calls).toHaveLength(4);
});
it('기존 작업이 활성 또는 수동 호출·다른 간격이면 재사용을 거부합니다',async()=>{
 const expected=makeWatchdogJob('owner/repo','secret').job;
 for(const changed of [{enabled:true},{extendedData:{...expected.extendedData,body:JSON.stringify({ref:'main',inputs:{mode:'discover-and-drain',invocation:'manual'}})}},{schedule:{...expected.schedule,minutes:[0]}},{extendedData:{...expected.extendedData,headers:{...expected.extendedData.headers,Authorization:'Bearer other'}}}]){
  const fetcher=vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);
   if(url.endsWith('/actions/workflows/pdf-extract.yml'))return Response.json({path:'.github/workflows/pdf-extract.yml',state:'active'});
   if(url==='https://api.cron-job.org/jobs')return Response.json({jobs:[{jobId:2,title:expected.title,url:expected.url}]});
   if(url==='https://api.cron-job.org/jobs/2')return Response.json({jobDetails:{...expected,...changed}});
   return Response.json({default_branch:'main'});
  });
  await expect(registerDisabledWatchdog({repository:'owner/repo',githubToken:'secret',cronKey:'key',fetcher})).rejects.toThrow();
 }
});
it('신규 작업은 비활성으로만 등록하고 외부 응답의 비밀값을 오류로 출력하지 않습니다',async()=>{
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);
  if(init?.method==='PUT'){expect(JSON.parse(String(init.body)).job.enabled).toBe(false);return Response.json({jobId:3});}
  if(url.endsWith('/actions/workflows/pdf-extract.yml'))return Response.json({path:'.github/workflows/pdf-extract.yml',state:'active'});
  if(url==='https://api.cron-job.org/jobs')return Response.json({jobs:[]});return Response.json({default_branch:'main'});
 });
 expect(await registerDisabledWatchdog({repository:'owner/repo',githubToken:'secret',cronKey:'key',fetcher})).toMatchObject({jobId:3,created:true,enabled:false});
 await expect(registerDisabledWatchdog({repository:'owner/repo',githubToken:'secret',cronKey:'key',fetcher:async()=>Response.json({error:'secret-token'}, {status:401})})).rejects.not.toThrow('secret-token');
});
