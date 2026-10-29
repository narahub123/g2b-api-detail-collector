import {describe,expect,it} from 'vitest';
import {pickPdfAttachment,pdfText} from './contract';
const key='R26BK01787632--000',fileNo='8d099a9b-22c2-4b70-9ef7-23ed5d48d208';
const url=`/api/attachments/${key}?fileNo=${fileNo}&seq=2`;
describe('운영 PDF 입력 경계',()=>{
 it('공고 소속의 직접 PDF만 선택하며 다른 공고·순번·모달을 거부합니다',()=>{
  const files=[{name:'공고.pdf',url},{name:'공고.hwp',url:url.replace('seq=2','seq=1')}];
  expect(pickPdfAttachment(key,fileNo,2,files).name).toBe('공고.pdf');
  expect(()=>pickPdfAttachment(key,fileNo,1,files)).toThrow();
  expect(()=>pickPdfAttachment('R26BK01799999--000',fileNo,2,files)).toThrow();
  expect(()=>pickPdfAttachment(key,fileNo,2,[{name:'공고.pdf',url:url+'&modal=0'}])).toThrow();
 });
 it('텍스트의 줄바꿈과 단어 경계를 보존합니다',()=>{
  expect(pdfText([{str:'참가'},{str:'자격',hasEOL:true},{str:'기한'}])).toBe('참가 자격\n기한');
 });
});
