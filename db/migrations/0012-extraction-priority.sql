-- 작업 중인 구 버전과 분류가 섞이지 않도록 기존 임대를 먼저 확인합니다.
DO $$ BEGIN
 PERFORM id FROM public.attachment_extraction_worker_lease WHERE id=1 FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.attachment_extraction_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp())
  OR EXISTS(SELECT 1 FROM public.attachment_extraction_runs WHERE status='processing') THEN
  RAISE EXCEPTION 'PDF 작업기가 실행 중입니다. 종료 후 우선순위 마이그레이션을 적용하세요.';
 END IF;
END $$;

ALTER TABLE public.attachment_extraction_runs ADD COLUMN IF NOT EXISTS purpose text
 CHECK(purpose IN ('initial','reextract'));
-- 최초 체인과 그 재시도는 신규로 유지하고 이후 체인만 재추출로 분류합니다.
WITH roots AS (
 SELECT id,document_id,row_number() OVER(PARTITION BY document_id ORDER BY requested_at,id) AS position
 FROM public.attachment_extraction_runs WHERE id=chain_id
)
UPDATE public.attachment_extraction_runs r SET purpose=CASE WHEN roots.position=1 THEN 'initial' ELSE 'reextract' END
 FROM roots WHERE r.chain_id=roots.id AND r.document_id=roots.document_id AND r.purpose IS NULL;
ALTER TABLE public.attachment_extraction_runs ALTER COLUMN purpose SET DEFAULT 'initial',ALTER COLUMN purpose SET NOT NULL;
CREATE INDEX IF NOT EXISTS attachment_runs_priority_ready_idx ON public.attachment_extraction_runs
 ((CASE WHEN source='manual' THEN 0 WHEN purpose='initial' THEN 1 ELSE 2 END),requested_at,id)
 WHERE status='queued';
COMMENT ON COLUMN public.attachment_extraction_runs.purpose IS '첨부 최초 추출 체인(initial) 또는 후속 재추출 체인(reextract). 재시도와 보류 후 재개는 원래 분류를 유지한다.';
