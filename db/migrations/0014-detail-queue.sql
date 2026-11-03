-- 상세 수집은 요청 작업과 실제 공고 실행을 분리하여 중복 실행 없이 결과를 공유합니다.
CREATE TABLE IF NOT EXISTS public.detail_collection_runs (
  id uuid PRIMARY KEY,
  notice_key text NOT NULL REFERENCES public.notices(key),
  source text NOT NULL CHECK (source IN ('manual','automatic')),
  purpose text NOT NULL CHECK (purpose IN ('initial','reextract')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','succeeded','failed')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_attempt_at timestamptz,
  owner_token uuid,
  started_at timestamptz,
  finished_at timestamptz,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  diagnostic jsonb,
  CHECK ((status='processing') = (owner_token IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS detail_collection_runs_active_idx
  ON public.detail_collection_runs(notice_key) WHERE status IN ('queued','processing');
CREATE INDEX IF NOT EXISTS detail_collection_runs_ready_idx
  ON public.detail_collection_runs(
    (CASE WHEN source='manual' THEN 0 WHEN purpose='initial' THEN 1 ELSE 2 END), requested_at, id)
  WHERE status='queued';

-- 이전 collection_jobs의 잠금·상태와 독립적으로 요청을 연결합니다.
CREATE TABLE IF NOT EXISTS public.detail_collection_requests (
  job_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES public.detail_collection_runs(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(job_id,run_id)
);
CREATE INDEX IF NOT EXISTS detail_collection_requests_run_idx ON public.detail_collection_requests(run_id);

CREATE TABLE IF NOT EXISTS public.detail_collection_worker_lease (
  id integer PRIMARY KEY CHECK(id=1),
  owner_token uuid,
  expires_at timestamptz,
  CHECK ((owner_token IS NULL) = (expires_at IS NULL))
);
INSERT INTO public.detail_collection_worker_lease(id) VALUES(1) ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.detail_collection_runs IS '공고별 상세 수집 실행과 소유권 및 대기 순서';
COMMENT ON COLUMN public.detail_collection_runs.id IS '상세 수집 실행 식별자';
COMMENT ON COLUMN public.detail_collection_runs.notice_key IS '상세를 수집하는 공고 키';
COMMENT ON COLUMN public.detail_collection_runs.source IS '직접 요청 또는 자동 요청의 출처';
COMMENT ON COLUMN public.detail_collection_runs.purpose IS '최초 수집 또는 보완·재수집 목적';
COMMENT ON COLUMN public.detail_collection_runs.status IS '대기·처리·성공·실패 상태';
COMMENT ON COLUMN public.detail_collection_runs.requested_at IS '같은 우선순위에서 처리 순서를 정하는 최초 접수 시각';
COMMENT ON COLUMN public.detail_collection_runs.next_attempt_at IS '이 시각 이후에만 선점 가능한 재시도 시각';
COMMENT ON COLUMN public.detail_collection_runs.owner_token IS '처리 중인 소비기의 임대 토큰';
COMMENT ON COLUMN public.detail_collection_runs.started_at IS '현재 실행의 실제 처리 시작 시각';
COMMENT ON COLUMN public.detail_collection_runs.finished_at IS '성공 또는 실패를 확정한 시각';
COMMENT ON COLUMN public.detail_collection_runs.progress IS '소유권 검사를 거쳐 저장한 공고별 중간 진행';
COMMENT ON COLUMN public.detail_collection_runs.error IS '비밀값을 제거한 실행 오류 요약';
COMMENT ON COLUMN public.detail_collection_runs.diagnostic IS '비밀값을 제거한 실행 오류 진단';
COMMENT ON TABLE public.detail_collection_requests IS '요청 작업과 공유하는 공고 실행의 연결';
COMMENT ON COLUMN public.detail_collection_requests.job_id IS '접수 작업 식별자이며 기존 작업 잠금과 독립적';
COMMENT ON COLUMN public.detail_collection_requests.run_id IS '요청 작업이 결과를 공유하는 상세 실행';
COMMENT ON COLUMN public.detail_collection_requests.requested_at IS '요청 작업과 실행을 연결한 접수 시각';
COMMENT ON TABLE public.detail_collection_worker_lease IS '상세 소비기의 단일 실행 임대';
COMMENT ON COLUMN public.detail_collection_worker_lease.id IS '단일 소비기 임대 행이며 항상 1';
COMMENT ON COLUMN public.detail_collection_worker_lease.owner_token IS '현재 소비기의 소유 토큰';
COMMENT ON COLUMN public.detail_collection_worker_lease.expires_at IS '소비기 임대 유효기간';
