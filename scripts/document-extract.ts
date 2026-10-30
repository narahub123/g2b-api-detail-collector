import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocumentPool } from "../src/lib/documents/pool";
import { DocumentQueue } from "../src/lib/documents/queue";
import { extractAttachmentPdf } from "../src/lib/documents/attachment-extraction";
import {diagnosticError} from '../src/lib/documents/diagnostics';
import type {ExtractionProgress} from '../src/lib/documents/diagnostics';

/** DB 갱신은 부모에게 맡기고 진행 정보만 프로세스 사이에 전달합니다. */
function progress(value:ExtractionProgress){process.send?.({type:'progress',progress:value});}

/** 선점한 실행의 소유권과 현재 첨부를 다시 확인하고 결과는 부모의 임시 경로에만 씁니다. */
async function main(){
  const [id,key,directory]=process.argv.slice(2);
  const token=process.env.PDF_EXTRACTION_OWNER_TOKEN;
  if(!token)throw new Error("PDF 실행 소유권이 올바르지 않습니다.");
  progress({stage:'attachment',at:new Date().toISOString()});
  const file=await new DocumentQueue(getDocumentPool()).executionFile(id,token,key);
  const result=await extractAttachmentPdf(file,join(directory,"downloads"),new AbortController().signal,undefined,progress);
  await writeFile(join(directory,"result.json"),JSON.stringify(result),{mode:0o600});
}
main().catch(async error=>{
  const diagnostic=diagnosticError(error);
  await writeFile(join(process.argv[4],"error.json"),JSON.stringify({error:diagnostic.message,diagnostic}),{mode:0o600}).catch(()=>undefined);
  process.exitCode=1;
}).finally(()=>getDocumentPool().end());
