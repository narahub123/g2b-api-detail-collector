-- 기존 미처리 자료를 반복 이관해도 중복 실행이 생기지 않게 합니다.
CREATE TABLE IF NOT EXISTS public.detail_collection_imports (
  notice_key text PRIMARY KEY REFERENCES public.notices(key),
  job_id uuid NOT NULL REFERENCES public.detail_collection_jobs(id),
  run_id uuid NOT NULL REFERENCES public.detail_collection_runs(id),
  purpose text NOT NULL CHECK(purpose IN ('initial','reextract')),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.detail_collection_imports IS '기존 미처리 자료를 상세 큐에 연결한 이관 감사 기록';
COMMENT ON COLUMN public.detail_collection_imports.notice_key IS '중복 이관을 방지하는 공고 키';
COMMENT ON COLUMN public.detail_collection_imports.job_id IS '이관으로 생성한 요청 작업';
COMMENT ON COLUMN public.detail_collection_imports.run_id IS '이관 시 연결한 상세 실행';
COMMENT ON COLUMN public.detail_collection_imports.purpose IS '최초 또는 보완 처리 분류';
COMMENT ON COLUMN public.detail_collection_imports.imported_at IS '이관을 확정한 시각';
