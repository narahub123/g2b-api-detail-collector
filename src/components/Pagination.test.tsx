import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {Pagination} from './Pagination';
it('전체 페이지 수 없이 확인된 다음 페이지를 표시하고 마지막 이동은 생략합니다',()=>{
 const html=renderToStaticMarkup(<Pagination page={1} hasNext href={p=>`/history?page=${p}`} label="추출 이력 페이지"/>);
 expect(html).toContain('class="notice-pagination"');expect(html).toContain('href="/history?page=2"');expect(html).toContain('aria-current="page"');expect(html).not.toContain('마지막으로');
});
it('전체 페이지 수가 없을 때 마지막 확인 페이지에서도 이전 이동을 제공합니다',()=>{
 const html=renderToStaticMarkup(<Pagination page={2} hasNext={false} href={p=>`/history?page=${p}`}/>);
 expect(html).toContain('href="/history?page=1"');expect(html).not.toContain('page=3');expect(html).toContain('aria-disabled="true">다음');
});
