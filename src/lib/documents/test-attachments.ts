import {buildDirectAttachmentUrl} from '../g2b/attachment-direct';

/** 실제 URL 생성 규칙과 분리된 식별 필드를 함께 갖는 테스트 첨부를 만듭니다. */
export function testAttachment(key:string,fileNo:string,seq:number,name='자료.pdf'){
 const [number,order]=key.split('--');
 const url=buildDirectAttachmentUrl({kind:'notice',number,order,businessCode:'03'},seq);
 if(!url)throw new Error('테스트 공고 식별자가 올바르지 않습니다.');
 return {name,url,fileNo,seq};
}
