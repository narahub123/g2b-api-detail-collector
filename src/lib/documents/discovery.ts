import {fixedAttachmentExclusionSql} from '../g2b/attachment-exclusions';
import { documentRegistrationEnabled } from './registration';

/** 발견과 사전 조회가 같은 직접 첨부 검증 기준을 사용하도록 공통 후보 SQL을 구성합니다. */
export function discoveryCandidatesSql(schema:string):string{
 if(!/^[a-z][a-z0-9_]*$/.test(schema))throw new Error('DB 스키마 이름이 올바르지 않습니다.');
 return `WITH matched AS (
  SELECT n.key,a->>'name' filename,a->>'url' attachment_url,a->>'fileNo' file_no,(a->>'seq')::int seq,
   count(*) OVER(PARTITION BY n.key,lower(a->>'fileNo'),(a->>'seq')::int) copies
  FROM ${schema}.notices n
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.detail->'attachments')='array' THEN n.detail->'attachments' ELSE '[]'::jsonb END) a
  WHERE ($1::text IS NULL OR n.key=$1) AND jsonb_typeof(a->'name')='string' AND (a->>'name')~*'[.]pdf[[:space:]]*$'
   AND (a->>'fileNo')~*'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   AND jsonb_typeof(a->'seq')='number' AND (a->>'seq')~'^[1-9][0-9]{0,8}$'
   AND ${fixedAttachmentExclusionSql("a->>'fileNo'","a->>'seq'")}
   AND (((a->>'url') LIKE 'https://www.g2b.go.kr/pn/pnp/pnpe/UntyAtchFile/downloadFile.do?%'
    AND substring(a->>'url' from '[?&]bidPbancNo=([^&]+)')||'--'||substring(a->>'url' from '[?&]bidPbancOrd=([^&]+)')=n.key)
    OR ((a->>'url') LIKE 'https://www.g2b.go.kr/fs/fsc/fsca/fileUpload.do?k00=%&fileNo=%&fileSeq=%'
    AND lower(substring(a->>'url' from '[?&]fileNo=([^&]+)'))=lower(a->>'fileNo')))
   AND substring(a->>'url' from '[?&]fileSeq=([^&]+)')=a->>'seq'
   AND n.key~'^[A-Za-z0-9_.%~-]+--[A-Za-z0-9_.%~-]+$' AND strpos(n.key,'..')=0
 ), attachments AS (SELECT * FROM matched WHERE copies=1), candidates AS (
  SELECT a.*,EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_runs r WHERE r.document_id=d.id) AS has_history
  FROM attachments a LEFT JOIN ${schema}.attachment_documents d ON d.notice_key=a.key AND d.file_no=a.file_no::uuid AND d.seq=a.seq
  WHERE NOT EXISTS(SELECT 1 FROM ${schema}.attachment_extraction_runs r WHERE r.document_id=d.id
   AND (${documentRegistrationEnabled() ? `r.invalidated_at IS NULL AND r.attachment_url=a.attachment_url AND r.attachment_revision=d.attachment_revision AND ` : ''}
    (r.status IN('queued','processing') OR r.extractor_version=$2)))
 )`;
}
