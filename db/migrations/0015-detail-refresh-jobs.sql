-- 선택 재수집 접수 정보는 실행 상태와 분리하여 여러 작업이 같은 실행을 공유합니다.
CREATE TABLE IF NOT EXISTS public.detail_collection_jobs (
  id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.detail_collection_jobs IS '큐 기반 선택 재수집의 변경되지 않는 접수 정보';
COMMENT ON COLUMN public.detail_collection_jobs.id IS '재수집 요청 작업 식별자';
COMMENT ON COLUMN public.detail_collection_jobs.requested_at IS '재수집 요청을 접수한 시각';
