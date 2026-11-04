-- 외부 실행 호출의 간격·소유권·요청 세대를 저장소별로 공유합니다.
CREATE TABLE IF NOT EXISTS public.pdf_dispatch_state (
  repository text PRIMARY KEY,
  requested_generation bigint NOT NULL DEFAULT 0 CHECK (requested_generation >= 0),
  acknowledged_generation bigint NOT NULL DEFAULT 0 CHECK (acknowledged_generation >= 0 AND acknowledged_generation <= requested_generation),
  claimed_generation bigint,
  owner_token uuid,
  lease_expires_at timestamptz,
  last_attempt_at timestamptz,
  attempt_count bigint NOT NULL DEFAULT 0,
  last_outcome text,
  last_http_status smallint,
  last_run_url text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((owner_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((owner_token IS NULL) = (claimed_generation IS NULL)),
  CHECK (claimed_generation IS NULL OR claimed_generation <= requested_generation)
);
COMMENT ON TABLE public.pdf_dispatch_state IS 'PDF 실행 요청의 저장소별 세대·5분 호출 간격·짧은 호출 임대. 인증 정보는 저장하지 않는다.';
