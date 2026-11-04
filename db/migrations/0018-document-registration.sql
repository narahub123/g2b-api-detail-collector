-- 상세 저장과 PDF 등록 사이의 실패를 공고별 최신 세대로 복구합니다.
CREATE TABLE IF NOT EXISTS public.document_registration_handoffs (
  notice_key text PRIMARY KEY REFERENCES public.notices(key) ON DELETE CASCADE,
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX IF NOT EXISTS document_registration_ready_idx
  ON public.document_registration_handoffs(next_attempt_at,requested_at,notice_key);
COMMENT ON TABLE public.document_registration_handoffs IS '상세 저장에 연결한 PDF 등록 복구 기록. 첨부 목록 대신 최신 공고 상세를 다시 확인한다.';
