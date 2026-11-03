-- API 접수 상태와 상세 완료를 분리하여 상세 대기 중에도 조회 구간을 이어갑니다.
ALTER TABLE public.detail_collection_jobs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'refresh'
  CHECK (mode IN ('refresh','collection','incremental'));
ALTER TABLE public.detail_collection_jobs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','automatic'));
ALTER TABLE public.detail_collection_jobs ADD COLUMN IF NOT EXISTS producer_status text NOT NULL DEFAULT 'completed'
  CHECK (producer_status IN ('queued','running','completed','failed','deferred'));
ALTER TABLE public.detail_collection_jobs ADD COLUMN IF NOT EXISTS producer_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.detail_collection_jobs ADD COLUMN IF NOT EXISTS api_completed_at timestamptz;
ALTER TABLE public.detail_collection_jobs ADD COLUMN IF NOT EXISTS producer_finished_at timestamptz;
ALTER TABLE public.detail_collection_jobs ADD COLUMN IF NOT EXISTS next_api_attempt_at timestamptz;
ALTER TABLE public.detail_collection_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES public.detail_collection_runs(id);

CREATE TABLE IF NOT EXISTS public.detail_collection_producer_lease (
  id integer PRIMARY KEY CHECK(id=1), job_id uuid REFERENCES public.detail_collection_jobs(id),
  owner_token uuid, expires_at timestamptz,
  CHECK ((owner_token IS NULL) = (expires_at IS NULL)),
  CHECK ((owner_token IS NULL) = (job_id IS NULL))
);
INSERT INTO public.detail_collection_producer_lease(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.detail_collection_checkpoints (
  activation_key text PRIMARY KEY, window_end timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.detail_collection_targets (
  job_id uuid NOT NULL REFERENCES public.detail_collection_jobs(id),
  notice_key text NOT NULL REFERENCES public.notices(key),
  is_related boolean NOT NULL DEFAULT false,
  PRIMARY KEY(job_id,notice_key)
);
CREATE INDEX IF NOT EXISTS detail_collection_jobs_api_ready_idx
  ON public.detail_collection_jobs(requested_at,id) WHERE producer_status IN ('queued','running','deferred');
COMMENT ON COLUMN public.detail_collection_jobs.mode IS '선택 재수집·날짜 수집·자동 증분 수집 구분';
COMMENT ON COLUMN public.detail_collection_jobs.source IS '후속 상세 요청이 이어받는 직접 또는 자동 출처';
COMMENT ON COLUMN public.detail_collection_jobs.producer_status IS '상세 완료와 별개인 API 생산자 상태';
COMMENT ON COLUMN public.detail_collection_jobs.producer_state IS '생산자 임대로 보호하는 API 입력·진행·진단';
COMMENT ON COLUMN public.detail_collection_jobs.api_completed_at IS '해당 API 구간의 원본과 상세 접수가 모두 확정된 시각';
COMMENT ON COLUMN public.detail_collection_jobs.producer_finished_at IS 'API 생산자의 최근 종료 시각';
COMMENT ON COLUMN public.detail_collection_jobs.next_api_attempt_at IS '점검 후 API 재개 가능한 시각';
COMMENT ON COLUMN public.detail_collection_runs.parent_run_id IS '자동 재시도를 생성한 이전 실패 실행';
COMMENT ON TABLE public.detail_collection_producer_lease IS '상세 소비와 병행 가능한 단일 API 생산자 임대';
COMMENT ON COLUMN public.detail_collection_producer_lease.id IS '항상 1인 생산자 임대 행';
COMMENT ON COLUMN public.detail_collection_producer_lease.job_id IS '현재 API 조회를 수행하는 요청 작업';
COMMENT ON COLUMN public.detail_collection_producer_lease.owner_token IS 'API 생산자 소유 토큰';
COMMENT ON COLUMN public.detail_collection_producer_lease.expires_at IS 'API 생산자 임대 유효기간';
COMMENT ON TABLE public.detail_collection_checkpoints IS 'API 저장과 상세 접수가 완료된 증분 조회 끝 시각';
COMMENT ON COLUMN public.detail_collection_checkpoints.activation_key IS '자동 활성화 식별자이며 미지정 실행은 빈 문자열';
COMMENT ON COLUMN public.detail_collection_checkpoints.window_end IS '상세 대기·실패와 독립적인 API 완료 지점';
COMMENT ON TABLE public.detail_collection_targets IS '작업별 방문 대상과 관련 공고 한도를 보존하는 집합';
COMMENT ON COLUMN public.detail_collection_targets.job_id IS '대상 탐색을 요청한 수집 작업';
COMMENT ON COLUMN public.detail_collection_targets.notice_key IS '같은 작업에서 중복 탐색하지 않는 공고 키';
COMMENT ON COLUMN public.detail_collection_targets.is_related IS '관련 탐색 한도 200건에 포함하는 대상 여부';
