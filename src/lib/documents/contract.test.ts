import {describe,expect,it} from 'vitest';
import {pickPdfAttachment,pdfText} from './contract';
const key='R26BK01787632--000',fileNo='8d099a9b-22c2-4b70-9ef7-23ed5d48d208';
const url=`https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do?bidPbancNo=R26BK01787632&bidPbancOrd=000&fileSeq=2&fileType=&prcmBsneSeCd=03`;
describe('운영 PDF 입력 경계',()=>{
 it('공고 소속의 직접 PDF만 선택하며 다른 공고·순번·모달을 거부합니다',()=>{
  const files=[{name:'공고.pdf',url,fileNo,seq:2},{name:'공고.hwp',url:url.replace('fileSeq=2','fileSeq=1'),fileNo,seq:1}];
  expect(pickPdfAttachment(key,fileNo,2,files).name).toBe('공고.pdf');
  expect(()=>pickPdfAttachment(key,fileNo,1,files)).toThrow();
  expect(()=>pickPdfAttachment('R26BK01799999--000',fileNo,2,files)).toThrow();
  expect(()=>pickPdfAttachment(key,fileNo,2,[{name:'공고.pdf',url:url+'&modal=0',fileNo,seq:2}])).toThrow();
  expect(()=>pickPdfAttachment(key,fileNo,2,[{name:'공고.pdf',url:`/api/attachments/${key}?fileNo=${fileNo}&seq=2`}])).toThrow();
  expect(()=>pickPdfAttachment(key,fileNo,2,[{...files[0],seq:3}])).toThrow();
 });
 it('텍스트의 줄바꿈과 단어 경계를 보존합니다',()=>{
  expect(pdfText([{str:'참가'},{str:'자격',hasEOL:true},{str:'기한'}])).toBe('참가 자격\n기한');
 });
 it('저장 배열의 잘못된 항목은 추출 직전 검증에서도 유효한 PDF를 막지 않습니다',()=>{
  const files=[null,{}, {name:123}, {name:'공고.pdf',url,fileNo,seq:2}] as unknown as Parameters<typeof pickPdfAttachment>[3];
  expect(pickPdfAttachment(key,fileNo,2,files).name).toBe('공고.pdf');
 });
});
