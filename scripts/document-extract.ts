import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocumentPool } from "../src/lib/documents/pool";
import { DocumentQueue } from "../src/lib/documents/queue";
import { extractAttachmentPdf } from "../src/lib/documents/attachment-extraction";

/** 선점한 실행의 소유권과 현재 첨부를 다시 확인하고 결과는 부모의 임시 경로에만 씁니다. */
async function main(){
  const [id,key,directory]=process.argv.slice(2);
  const token=process.env.PDF_EXTRACTION_OWNER_TOKEN;
  if(!token)throw new Error("PDF 실행 소유권이 올바르지 않습니다.");
  const file=await new DocumentQueue(getDocumentPool()).executionFile(id,token,key);
  const result=await extractAttachmentPdf(file,join(directory,"downloads"),new AbortController().signal);
  await writeFile(join(directory,"result.json"),JSON.stringify(result),{mode:0o600});
}
main().catch(async error=>{
  await writeFile(join(process.argv[4],"error.json"),JSON.stringify({error:error instanceof Error?error.message:"추출 실패"}),{mode:0o600}).catch(()=>undefined);
  process.exitCode=1;
}).finally(()=>getDocumentPool().end());
