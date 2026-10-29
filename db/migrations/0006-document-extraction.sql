-- 공고 직접 첨부의 식별자와 마지막 성공·최근 시도 포인터를 분리합니다.
CREATE TABLE IF NOT EXISTS public.attachment_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_key text NOT NULL REFERENCES public.notices(key),
  file_no uuid NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  filename text NOT NULL,
  attachment_url text NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  active_chain_id uuid,
  last_success_run_id uuid,
  latest_run_id uuid,
  current_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notice_key,file_no,seq)
);

-- 실행마다 본문을 보존해 새 시도의 실패가 이전 성공 결과를 변경하지 못하게 합니다.
CREATE TABLE IF NOT EXISTS public.attachment_extraction_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.attachment_documents(id),
  chain_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('automatic','manual','poc_import')),
  status text NOT NULL CHECK (status IN ('queued','processing','completed','no_text','failed','interrupted','unsupported')),
  retry_of uuid,
  attempt_number smallint NOT NULL DEFAULT 1 CHECK (attempt_number BETWEEN 1 AND 3),
  retry_eligible boolean NOT NULL DEFAULT false,
  next_attempt_at timestamptz,
  owner_token uuid,
  error_code text,
  error text,
  filename text NOT NULL,
  attachment_url text NOT NULL,
  pages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pages)='array'),
  page_count integer CHECK (page_count >= 0),
  character_count integer CHECK (character_count >= 0),
  extractor_version text,
  file_hash text,
  peak_memory_bytes bigint CHECK (peak_memory_bytes >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  elapsed_ms bigint CHECK (elapsed_ms >= 0),
  UNIQUE (id,document_id),
  UNIQUE (id,document_id,chain_id),
  UNIQUE (chain_id,attempt_number),
  CHECK ((attempt_number=1 AND retry_of IS NULL AND chain_id=id) OR
    (attempt_number>1 AND retry_of IS NOT NULL AND retry_of<>id)),
  CHECK (status<>'processing' OR owner_token IS NOT NULL),
  FOREIGN KEY (chain_id,document_id) REFERENCES public.attachment_extraction_runs(id,document_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (retry_of,document_id,chain_id) REFERENCES public.attachment_extraction_runs(id,document_id,chain_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS attachment_runs_one_active_idx
  ON public.attachment_extraction_runs(document_id) WHERE status IN ('queued','processing');
CREATE UNIQUE INDEX IF NOT EXISTS attachment_runs_one_retry_idx
  ON public.attachment_extraction_runs(retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachment_runs_history_idx
  ON public.attachment_extraction_runs(document_id,requested_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS attachment_runs_ready_idx
  ON public.attachment_extraction_runs(next_attempt_at,requested_at,id) WHERE status='queued';

-- 문서와 실행의 순환 참조는 두 테이블을 만든 뒤 추가합니다.
DO $$
DECLARE pointer_column text;
        constraint_name text;
BEGIN
  FOREACH pointer_column IN ARRAY ARRAY['active_chain_id','last_success_run_id','latest_run_id','current_run_id'] LOOP
    constraint_name := 'attachment_documents_' || pointer_column || '_fkey';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.attachment_documents'::regclass AND conname=constraint_name) THEN
      EXECUTE format('ALTER TABLE public.attachment_documents ADD CONSTRAINT %I FOREIGN KEY (%I,id) REFERENCES public.attachment_extraction_runs(id,document_id) DEFERRABLE INITIALLY DEFERRED',constraint_name,pointer_column);
    END IF;
  END LOOP;
END $$;

-- 풀링 연결에서도 조건부 갱신으로 작업기 소유권을 확인할 수 있는 단일 임대입니다.
CREATE TABLE IF NOT EXISTS public.attachment_extraction_worker_lease (
  id integer PRIMARY KEY CHECK (id=1),
  owner_token uuid,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_token IS NULL) = (expires_at IS NULL))
);
INSERT INTO public.attachment_extraction_worker_lease(id) VALUES(1) ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.attachment_documents IS '공고별 직접 첨부 문서와 최근 시도·마지막 성공 결과 연결.';
COMMENT ON TABLE public.attachment_extraction_runs IS '자동·수동 문서 추출의 시도별 이력과 페이지 본문. PoC 원본은 별도 보존한다.';
COMMENT ON TABLE public.attachment_extraction_worker_lease IS '로컬·클라우드 추출 작업기가 공유할 만료 가능한 소유권. 실행 로직은 후속 단계에서 연결한다.';
