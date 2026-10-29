import {appendFile} from 'node:fs/promises';
import {getDocumentPool} from '../src/lib/documents/pool';
import {probePdfWork} from '../src/lib/documents/preflight';

/** Docker 빌드 전에 읽기 전용 조회로 처리·복구 대상 존재만 출력합니다. */
async function main(){
 const mode=process.env.PDF_BATCH_MODE;
 if(!['queue-only','discover-and-drain'].includes(mode??''))throw new Error('PDF 배치 모드를 확인하세요.');
 const result=await probePdfWork(getDocumentPool(),process.env.G2B_DB_SCHEMA||'public',{discover:mode==='discover-and-drain',noticeKey:process.env.PDF_NOTICE_KEY||undefined});
 if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`needed=${result.needed}\n`);
 console.log(JSON.stringify({operation:'pdf-preflight',...result}));
}
main().catch(()=>{console.error(JSON.stringify({operation:'pdf-preflight',error:'사전 조회가 실패했습니다. DB 설정을 확인하세요.'}));process.exitCode=1;}).finally(()=>getDocumentPool().end());
