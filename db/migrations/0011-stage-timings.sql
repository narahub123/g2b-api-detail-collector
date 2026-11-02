-- 기존 실행은 추정하지 않고 빈 기록으로 유지합니다.
ALTER TABLE public.attachment_extraction_runs ADD COLUMN IF NOT EXISTS stage_timings jsonb NOT NULL DEFAULT '[]'::jsonb
 CHECK(jsonb_typeof(stage_timings)='array');
COMMENT ON COLUMN public.attachment_extraction_runs.stage_timings IS '실행 단계별 시작·종료·소요 시간·종료 사유. 보류 후 재개는 별도 구간으로 기록한다.';
