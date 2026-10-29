import {expect,it} from 'vitest';
import {evaluatePdfEvent,makeWatchdogJob} from '../../../scripts/lib/pdf-automation.mjs';
const repository='narahub123/g2b-api-detail-collector';
const base={eventName:'workflow_dispatch',ref:'refs/heads/main',repository,enabled:'false',event:{repository:{full_name:repository,default_branch:'main'},inputs:{mode:'queue-only',invocation:'manual'}}};
it('자동 실행이 꺼져도 기본 브랜치 수동 검증은 허용하고 watchdog은 차단합니다',()=>{
 expect(evaluatePdfEvent(base)).toMatchObject({allowed:true,mode:'queue-only',limit:20});
 expect(evaluatePdfEvent({...base,event:{...base.event,inputs:{mode:'queue-only',invocation:'watchdog'}}})).toMatchObject({allowed:false,reason:'disabled'});
 expect(evaluatePdfEvent({...base,ref:'refs/heads/feature'}).allowed).toBe(false);
});
it('독립 watchdog은 수집 이벤트 필드 없이 실행하며 허용 입력만 받습니다',()=>{
 expect(evaluatePdfEvent({...base,enabled:'true',event:{...base.event,inputs:{mode:'queue-only',invocation:'watchdog'}}}).allowed).toBe(true);
 for(const inputs of [{mode:'unknown',invocation:'manual'},{mode:'discover-and-drain',invocation:'watchdog'},{mode:'queue-only',invocation:'other'},{mode:'queue-only',invocation:'manual',limit:'21'},{mode:'queue-only',invocation:'manual',notice_key:'x;echo secret'}])expect(evaluatePdfEvent({...base,enabled:'true',event:{...base.event,inputs}}).allowed).toBe(false);
});
it('신뢰하는 수집의 성공·실패·취소·시간 초과 종료만 허용합니다',()=>{
 const run={name:'G2B collection',path:'.github/workflows/collect.yml',event:'workflow_dispatch',head_branch:'main',head_repository:{full_name:repository},conclusion:'success',status:'completed'};
 const ctx={...base,eventName:'workflow_run',enabled:'true',event:{repository:base.event.repository,action:'completed',workflow_run:run}};
 for(const conclusion of ['success','failure','cancelled','timed_out'])expect(evaluatePdfEvent({...ctx,event:{...ctx.event,workflow_run:{...run,conclusion}}})).toMatchObject({allowed:true,mode:'discover-and-drain'});
 for(const change of [{event:'pull_request'},{head_branch:'feature'},{head_repository:{full_name:'fork/repo'}},{path:'.github/workflows/other.yml'},{conclusion:'skipped'},{name:'Other workflow'}])expect(evaluatePdfEvent({...ctx,event:{...ctx.event,workflow_run:{...run,...change}}}).allowed).toBe(false);
 expect(evaluatePdfEvent({...ctx,enabled:'false'}).allowed).toBe(false);
});
it('보완 작업은 비활성·10분 간격·queue-only이며 토큰은 헤더에만 둡니다',()=>{
 const result=makeWatchdogJob(repository,'token');
 expect(result.job.enabled).toBe(false);expect(result.job.schedule.minutes).toEqual([0,10,20,30,40,50]);
 expect(JSON.parse(result.job.extendedData.body)).toEqual({ref:'main',inputs:{mode:'queue-only',invocation:'watchdog'}});
 expect(result.job.url).not.toContain('token');expect(result.job.extendedData.headers.Authorization).toBe('Bearer token');
 expect(result.job.saveResponses).toBe(false);
});
