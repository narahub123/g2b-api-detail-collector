import {expect,it,vi} from 'vitest';
import {DocumentOverviewStore} from './overview-store';

it('빈 문서와 모든 상태를 0으로 반환합니다',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{generated_at:'2026-10-30T00:00:00.000Z',counts:null,activity:null,processing:null}]});
 const value=await new DocumentOverviewStore({query} as never).overview();
 expect(value.totals).toEqual({total:0,unrequested:0,queued:0,processing:0,completed:0,no_text:0,failed:0,interrupted:0,unsupported:0});
 expect(value.byType).toEqual([]);expect(value.workflow.processing).toEqual([]);
 expect(value.workflow.totals).toMatchObject({queued:0,ready:0,scheduled:0,processing:0,stages:{unknown:0}});
});

it('유형별 통계와 재시도 대기·단계 집계를 전체 합계로 합칩니다',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{generated_at:'2026-10-30T00:00:00.000Z',
  counts:[{type:'pdf',status:'queued',count:2},{type:'pdf',status:'processing',count:1},{type:'hwp',status:'completed',count:1},{type:null,status:'unrequested',count:1}],
  activity:[{type:'pdf',status:'queued',stage:null,scheduled:false,count:1},{type:'pdf',status:'queued',stage:null,scheduled:true,count:1},{type:'pdf',status:'processing',stage:'extracting',scheduled:false,count:1}],
  processing:[{id:'run',filename:'자료.pdf',type:'pdf',stage:'extracting',last_progress_at:null,completed_pages:1,total_pages:3,current_page:2,stage_started_at:null}],
 }]});
 const value=await new DocumentOverviewStore({query} as never).overview();
 expect(value.totals).toMatchObject({total:5,queued:2,processing:1,completed:1,unrequested:1});
 expect(value.byType.find(item=>item.type===null)?.counts.unrequested).toBe(1);
 expect(value.workflow.totals).toMatchObject({queued:2,ready:1,scheduled:1,processing:1,stages:{extracting:1,unknown:0}});
 expect(value.workflow.byType.find(item=>item.type==='hwp')).toMatchObject({queued:0,processing:0});
 expect(value.workflow.processing[0]).toMatchObject({id:'run',total_pages:3});
 expect(query).toHaveBeenCalledTimes(1);
});
