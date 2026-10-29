import {getDocumentPool} from '../src/lib/documents/pool';
import {retirePdfPoc} from '../src/lib/documents/retirement';

/** 승인된 원본 테이블 삭제만 실행하고 연결 정보나 본문은 출력하지 않습니다. */
async function main(){
 const pool=getDocumentPool();
 try{await retirePdfPoc(pool);console.log(JSON.stringify({operation:'retire-pdf-poc',completed:true}));}
 finally{await pool.end();}
}
main().catch(()=>{console.error('PoC 테이블 삭제를 완료하지 못했습니다. DB 연결·잠금·종속성을 확인하세요.');process.exitCode=1;});
