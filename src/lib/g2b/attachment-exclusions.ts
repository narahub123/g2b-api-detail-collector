const fixedFiles:Record<string,readonly number[]>={
 'b0de33f9-8021-4b13-8b5c-8e000a9cc20a':[1,2,3,4],
 '6c99d36f-f22c-43a3-abcc-4ccccf2b5787':[1,2],
 '9fa6563a-4749-4a39-90bf-4d3a87b563cb':[1,2],
 '1753c128-4b96-49af-954d-9c88879917bc':[1],
 '2d40802d-0751-4538-805c-d6cb3f69882d':[1],
 '51321192-95c6-4e27-987a-76135cdd9b0c':[1,2,3],
};

/** 별도 작업하기로 한 기존 13개 파일을 주소 변경 여부와 무관하게 구분합니다. */
export function isFixedAttachmentExclusion(fileNo:string,seq:number):boolean{return fixedFiles[fileNo.toLowerCase()]?.includes(seq)??false;}

/** 코드에서 지정한 식별 열로 고정 보류 파일을 선점·발견 대상에서 제외합니다. */
export function fixedAttachmentExclusionSql(fileNoSql:string,seqSql:string):string{
 const keys=Object.entries(fixedFiles).flatMap(([no,seqs])=>seqs.map(seq=>`'${no}:${seq}'`));
 return `NOT (lower(${fileNoSql})||':'||(${seqSql})::text = ANY(ARRAY[${keys.join(',')}]::text[]))`;
}
