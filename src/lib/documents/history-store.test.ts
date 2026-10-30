import {expect,it,vi} from 'vitest';
import {DocumentHistoryStore,parseHistoryFilters} from './history-store';

it('한국 날짜 범위를 검증하고 상태·형식을 검사합니다',()=>{
 const filter=parseHistoryFilters(new URLSearchParams('from=2026-10-30&to=2026-10-30&status=failed&type=pdf&page=2'));
 expect(filter).toMatchObject({from:'2026-10-30',to:'2026-10-30',status:'failed',type:'pdf',page:2});
 expect(()=>parseHistoryFilters(new URLSearchParams('from=2026-02-30'))).toThrow();
 expect(()=>parseHistoryFilters(new URLSearchParams('status=wrong'))).toThrow();
 expect(()=>parseHistoryFilters(new URLSearchParams('from=2026-10-31&to=2026-10-30'))).toThrow();
});
it('전체 이력은 본문·스택 없이 읽고 매개변수로 필터링합니다',async()=>{
 const query=vi.fn().mockResolvedValueOnce({rows:Array.from({length:20},(_,i)=>({id:String(i)}))}).mockResolvedValueOnce({rows:[{total_count:'41'}]});
 const store=new DocumentHistoryStore({query} as never);
 const result=await store.list(parseHistoryFilters(new URLSearchParams('filename=%25_secret&type=pdf')));
 expect(result.items).toHaveLength(20);expect(result.hasNext).toBe(true);
 expect(result).toMatchObject({totalCount:41,totalPages:3});
 const [sql,values]=query.mock.calls[0];
 expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|diagnostic_error|owner_token|r\.pages/);
 expect(values).toContain('%\\%\\_secret%');expect(sql).not.toContain('_secret');
 const [countSql,countValues]=query.mock.calls[1];expect(countSql).toContain('COUNT(*)');expect(countValues).toEqual(values.slice(0,6));
 expect(countSql.slice(countSql.indexOf('FROM'))).toBe(sql.slice(sql.indexOf('FROM'),sql.indexOf('ORDER BY')).trimEnd());
});
it.each([0,20,21,40])('전체 건수 %i에 맞는 마지막 페이지를 계산합니다',async total=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{total_count:String(total)}]});
 const result=await new DocumentHistoryStore({query} as never).list(parseHistoryFilters(new URLSearchParams()));
 expect(result.totalCount).toBe(total);expect(result.totalPages).toBe(Math.max(1,Math.ceil(total/20)));expect(result.hasNext).toBe(total>20);
});
it('1000페이지를 넘어도 전체 건수에 따른 마지막 페이지로 이동할 수 있습니다',()=>{
 expect(parseHistoryFilters(new URLSearchParams('page=1001')).page).toBe(1001);
});
