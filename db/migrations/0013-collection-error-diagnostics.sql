-- 기존 오류 요약은 유지하고 정제된 원인 객체를 별도 보존합니다.
ALTER TABLE public.notices ADD COLUMN IF NOT EXISTS detail_diagnostic jsonb;
ALTER TABLE public.collection_notice_attempts ADD COLUMN IF NOT EXISTS diagnostic_error jsonb;
