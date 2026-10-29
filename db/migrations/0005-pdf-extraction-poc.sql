-- PoC는 매 시도를 별도 행으로 보관해 성공 결과를 덮어쓰지 않습니다.
CREATE TABLE IF NOT EXISTS public.pdf_extraction_poc_runs (
  id uuid PRIMARY KEY,
  notice_key text NOT NULL REFERENCES public.notices(key),
  file_no uuid NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  filename text NOT NULL,
  attachment_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','completed','no_text','failed','interrupted')),
  error text,
  pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  page_count integer,
  character_count integer,
  extractor_version text,
  file_hash text,
  peak_memory_bytes bigint,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  elapsed_ms bigint
);
CREATE INDEX IF NOT EXISTS pdf_extraction_poc_notice_idx ON public.pdf_extraction_poc_runs(notice_key,started_at DESC);
COMMENT ON TABLE public.pdf_extraction_poc_runs IS '관리자 수동 PDF PoC의 실행별 텍스트와 결과. 기존 수집 작업과 분리한다.';
