-- 기존 기록은 보존하고 새 실행부터 공통 문서 진단을 기록합니다.
ALTER TABLE public.attachment_documents ADD COLUMN IF NOT EXISTS document_type text;
ALTER TABLE public.attachment_extraction_runs
 ADD COLUMN IF NOT EXISTS document_type text,
 ADD COLUMN IF NOT EXISTS stage text CHECK (stage IN ('attachment','download','opening','extracting','saving')),
 ADD COLUMN IF NOT EXISTS stage_started_at timestamptz,
 ADD COLUMN IF NOT EXISTS last_progress_at timestamptz,
 ADD COLUMN IF NOT EXISTS current_page integer CHECK (current_page BETWEEN 0 AND 500),
 ADD COLUMN IF NOT EXISTS completed_pages integer CHECK (completed_pages BETWEEN 0 AND 500),
 ADD COLUMN IF NOT EXISTS total_pages integer CHECK (total_pages BETWEEN 0 AND 500),
 ADD COLUMN IF NOT EXISTS diagnostic_error jsonb;
CREATE INDEX IF NOT EXISTS attachment_runs_admin_history_idx ON public.attachment_extraction_runs(requested_at DESC,id DESC);
