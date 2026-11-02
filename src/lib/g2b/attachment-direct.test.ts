import {expect,it} from 'vitest';
import {buildDirectAttachmentUrl,businessCode,validateDirectAttachmentUrl,directAttachmentIdentity} from './attachment-direct';

it('첨부 업무별 실제 다운로드 경로와 파일순서를 구성합니다',()=>{
 const notice=buildDirectAttachmentUrl({kind:'notice',number:'R26BK01800675',order:'000',businessCode:'03'},3)!;
 expect(new URL(notice).searchParams.get('fileSeq')).toBe('3');
 expect(new URL(notice).pathname).toBe('/pn/pnp/pnpe/UntyAtchFile/downloadFile.do');
 const spec=buildDirectAttachmentUrl({kind:'pre-specification',number:'R26BD00281109',businessCode:'03'},1)!;
 expect(new URL(spec).searchParams.get('fileType')).toBe('BFDTL');
 const plan=buildDirectAttachmentUrl({kind:'order-plan',number:'R26DD20891692',businessCode:'05'},2)!;
 expect(new URL(plan).searchParams.get('oderPlanNo')).toBe('R26DD20891692');
 expect(businessCode('기술용역')).toBe('05');
 expect(validateDirectAttachmentUrl(spec)).toBe(spec);
});

it('다른 자료의 번호와 불명확한 업무 또는 외부 주소는 거부합니다',()=>{
 expect(buildDirectAttachmentUrl({kind:'notice',number:'R26BD00281109',order:'000',businessCode:'03'},1)).toBeNull();
 expect(buildDirectAttachmentUrl({kind:'notice',number:'R26BK01800675',businessCode:'03'},1)).toBeNull();
 expect(buildDirectAttachmentUrl({kind:'order-plan',number:'R26DD20891692',businessCode:''},1)).toBeNull();
 expect(validateDirectAttachmentUrl('https://evil.test/downloadFile.do')).toBeNull();
 expect(validateDirectAttachmentUrl('/api/attachments/key')).toBeNull();
});

it('주소가 직접 형식이어도 별도 보류한 파일은 추출 대상으로 선택하지 않습니다',()=>{
 const key='R26BK01800504--000';
 const url=buildDirectAttachmentUrl({kind:'notice',number:'R26BK01800504',order:'000',businessCode:'03'},1)!;
 expect(directAttachmentIdentity(key,{url,fileNo:'b0de33f9-8021-4b13-8b5c-8e000a9cc20a',seq:1})).toBeNull();
 expect(directAttachmentIdentity(key,{url,fileNo:'12345678-1234-1234-1234-123456789012',seq:1})).not.toBeNull();
});
