import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {AdminHistoryCard} from './AdminHistoryCard';
it('카드 전체를 한 링크로 표시하고 제목·설명을 제공합니다',()=>{
 const html=renderToStaticMarkup(<AdminHistoryCard href="/admin/collections" title="수집 작업 이력" description="오류 진단" icon="collection"/>);
 expect(html).toContain('href="/admin/collections"');expect(html).toContain('수집 작업 이력');expect(html).toContain('오류 진단');
 expect(html.match(/<a /g)).toHaveLength(1);expect(html).not.toContain('<button');
});
