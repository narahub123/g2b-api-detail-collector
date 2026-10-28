-- 공고번호·차수별 원본 자료와 화면·분석용 요약 값을 함께 보관합니다.
-- 아래 SQL 주석은 파일 독자를 위한 설명이고, 하단 COMMENT ON은 DB 메타데이터에 저장됩니다.
CREATE TABLE IF NOT EXISTS public.notices (
  -- 공고번호와 차수를 '--'로 결합한 앱 내부 식별자입니다.
  key text PRIMARY KEY,
  -- 나라장터 입찰공고번호(bidNtceNo)입니다.
  notice_number text NOT NULL,
  -- 앞의 0을 보존하는 입찰공고차수입니다.
  notice_order text NOT NULL,
  -- 해당 공고의 API 원본 항목이며, API에서 발견하지 못한 관련 공고는 NULL입니다.
  api jsonb,
  -- 상세 페이지에서 구조화한 섹션·필드·표·첨부·모달 자료입니다.
  detail jsonb,
  -- 마지막 상세 수집 오류이며, 오류가 나도 기존 상세는 유지될 수 있습니다.
  detail_error text,
  -- 상세 값을 우선하고 없으면 API 값으로 채우는 표시용 공고명입니다.
  title text,
  -- 상세 값을 우선하는 표시용 수요기관명입니다.
  demand_agency text,
  -- 상세 값을 우선하는 표시용 공고기관명입니다.
  notice_agency text,
  -- 나라장터 현지 시각 그대로 저장한 공고 게시일시입니다.
  posted_at timestamp without time zone,
  -- 나라장터 현지 시각 그대로 저장한 입찰 마감일시입니다.
  deadline_at timestamp without time zone,
  -- 확인된 사업금액·예산·추정가격을 원 단위 숫자로 변환한 값입니다.
  amount numeric,
  -- 참가 가능 지역 또는 지역 제한의 표시용 값입니다.
  region text,
  -- 용역개요·과업내용·사업내용 등에서 선택한 표시용 설명입니다.
  description text,
  -- 용역기간·사업기간·계약기간 중 확인된 기간입니다.
  service_period text,
  -- 상세 페이지에서 확인한 입찰자격 또는 업종제한입니다.
  qualifications text,
  -- 이 행을 만들거나 마지막으로 갱신한 DB 시각입니다.
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 같은 공고번호의 차수별 자료는 각각 한 행만 둡니다.
  UNIQUE (notice_number, notice_order)
);
-- 목록 정렬과 기관·금액 분석에 쓰는 인덱스입니다.
CREATE INDEX IF NOT EXISTS notices_posted_at_idx ON public.notices (posted_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS notices_demand_agency_idx ON public.notices (demand_agency);
CREATE INDEX IF NOT EXISTS notices_notice_agency_idx ON public.notices (notice_agency);
CREATE INDEX IF NOT EXISTS notices_amount_idx ON public.notices (amount);

-- 여러 공고가 공유할 수 있는 번호별 독립 상세이며, 먼저 저장한 내용을 유지합니다.
CREATE TABLE IF NOT EXISTS public.independent_details (
  -- 번호별 상세에는 나라장터 번호, 번호 없는 개찰 상세에는 공고·재입찰 조합 키를 사용합니다.
  detail_key text PRIMARY KEY,
  -- order-plan=발주계획, pre-specification=사전규격, other=그 밖의 상세, opening=개찰입니다.
  category text NOT NULL CHECK (category IN ('order-plan', 'pre-specification', 'other', 'opening')),
  -- 제목·필드·표·수집시각·출처 공고를 포함하는 구조화 자료입니다.
  payload jsonb NOT NULL
);
-- 공고가 참조하는 독립 상세와 해당 번호를 발견한 클릭 출처를 기록합니다.
CREATE TABLE IF NOT EXISTS public.notice_independent_refs (
  -- 독립 상세를 참조하는 공고의 내부 식별자입니다.
  notice_key text NOT NULL REFERENCES public.notices(key) ON DELETE CASCADE,
  -- 참조할 독립 상세 번호이며, 내용이 아직 없으면 독립 상세 행이 없을 수 있습니다.
  detail_key text NOT NULL,
  -- 참조한 독립 상세의 종류입니다.
  category text NOT NULL CHECK (category IN ('order-plan', 'pre-specification', 'other', 'opening')),
  -- 같은 공고·종류에서 발견된 순서이며 0부터 시작합니다.
  position integer NOT NULL,
  -- 번호를 발견한 클릭 요소의 위치·라벨·값을 담은 JSON 배열입니다.
  triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 한 공고가 같은 종류의 같은 번호를 중복 참조하지 않게 합니다.
  PRIMARY KEY (notice_key, category, detail_key)
);
CREATE INDEX IF NOT EXISTS notice_independent_refs_detail_key_idx ON public.notice_independent_refs (detail_key);

-- 상세 페이지에서 직접 발견한 공고 관계를 양방향 두 행으로 기록합니다.
CREATE TABLE IF NOT EXISTS public.notice_relations (
  -- 관계의 출발 공고입니다.
  source_key text NOT NULL REFERENCES public.notices(key) ON DELETE CASCADE,
  -- 출발 공고에서 발견한 관련 공고입니다.
  related_key text NOT NULL REFERENCES public.notices(key) ON DELETE CASCADE,
  -- 같은 방향의 관계를 한 번만 저장하고 자기 자신과의 관계는 금지합니다.
  PRIMARY KEY (source_key, related_key),
  CHECK (source_key <> related_key)
);

-- 수집 작업 상태는 웹 서버와 독립 실행기가 공유하는 DB 기록으로 유지합니다.
CREATE TABLE IF NOT EXISTS public.collection_jobs (
  id uuid PRIMARY KEY,
  state jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collection_jobs_started_at_idx ON public.collection_jobs (started_at DESC);

-- 한 번에 한 작업만 실행하도록 임대 소유자와 만료 시각을 보관합니다.
CREATE TABLE IF NOT EXISTS public.collection_lock (
  id integer PRIMARY KEY CHECK (id = 1),
  job_id uuid,
  token uuid,
  expires_at timestamptz
);
INSERT INTO public.collection_lock (id) VALUES (1) ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.notices IS '공고번호와 차수별 수집 자료. API 항목과 상세 원문을 보존하고 자주 조회하는 요약 값은 별도 컬럼에 둔다.';
COMMENT ON COLUMN public.notices.key IS '공고번호와 공고차수를 --로 결합한 앱 내부 식별자.';
COMMENT ON COLUMN public.notices.notice_number IS '나라장터 입찰공고번호를 문자열로 보존한 값. API의 bidNtceNo에 해당한다.';
COMMENT ON COLUMN public.notices.notice_order IS '입찰공고차수. 000처럼 앞의 0을 보존한다.';
COMMENT ON COLUMN public.notices.api IS '나라장터 API에서 받은 해당 공고의 원본 항목 JSON. 관련 공고처럼 API 항목이 없으면 NULL.';
COMMENT ON COLUMN public.notices.detail IS '공개 상세 페이지에서 수집해 구조화한 섹션·필드·표·첨부·모달 자료 JSON. 상세 수집 전에는 NULL.';
COMMENT ON COLUMN public.notices.detail_error IS '마지막 상세 수집 실패 메시지. 성공 시 NULL이며 실패해도 기존 detail은 보존할 수 있다.';
COMMENT ON COLUMN public.notices.title IS '화면 표시용 공고명. 상세 필드 값을 우선하고 없으면 API 값을 사용한다.';
COMMENT ON COLUMN public.notices.demand_agency IS '화면 표시용 수요기관명. 상세의 수요기관 필드를 우선하고 없으면 API의 dminsttNm을 사용한다.';
COMMENT ON COLUMN public.notices.notice_agency IS '화면 표시용 공고기관명. 상세의 공고기관 필드를 우선하고 없으면 API의 ntceInsttNm을 사용한다.';
COMMENT ON COLUMN public.notices.posted_at IS '공고 게시일시. 나라장터 현지 시각을 시간대 변환 없이 저장한다.';
COMMENT ON COLUMN public.notices.deadline_at IS '입찰 마감일시. 나라장터 현지 시각을 시간대 변환 없이 저장한다.';
COMMENT ON COLUMN public.notices.amount IS '표시용 사업금액·배정예산·추정가격 중 확인된 금액을 숫자로 변환한 값. 단위는 원이며 유효하지 않으면 NULL.';
COMMENT ON COLUMN public.notices.region IS '참가 가능 지역 또는 지역 제한의 표시용 값.';
COMMENT ON COLUMN public.notices.description IS '용역개요·과업내용·사업내용 등에서 선택한 표시용 설명.';
COMMENT ON COLUMN public.notices.service_period IS '용역기간·사업기간·계약기간 중 확인된 표시용 기간.';
COMMENT ON COLUMN public.notices.qualifications IS '상세 페이지의 입찰자격 또는 업종제한에서 선택한 표시용 참가 자격.';
COMMENT ON COLUMN public.notices.updated_at IS '이 공고 행을 처음 만들거나 마지막으로 갱신한 DB 시각.';

COMMENT ON TABLE public.independent_details IS '여러 공고가 참조할 수 있는 번호별 독립 상세. 번호별 첫 수집 내용을 유지한다.';
COMMENT ON COLUMN public.independent_details.detail_key IS '번호별 상세는 나라장터 번호, 번호 없는 개찰 상세는 공고·재입찰 조합 키를 사용한다. 이 테이블에서 고유하다.';
COMMENT ON COLUMN public.independent_details.category IS '독립 상세 종류: order-plan은 발주계획, pre-specification은 사전규격, other는 그 밖의 번호별 상세, opening은 개찰 상세.';
COMMENT ON COLUMN public.independent_details.payload IS '제목·필드·표·수집시각·출처 공고 등을 포함한 구조화된 독립 상세 JSON.';

COMMENT ON TABLE public.notice_independent_refs IS '공고가 참조하는 번호별 독립 상세와 그 클릭 출처를 기록한다. 상세 재수집 시 해당 공고의 참조를 교체한다.';
COMMENT ON COLUMN public.notice_independent_refs.notice_key IS '독립 상세를 참조하는 공고의 notices.key.';
COMMENT ON COLUMN public.notice_independent_refs.detail_key IS '참조할 독립 상세의 문자열 식별자. 실제 내용이 아직 없으면 독립 상세 행이 없을 수 있다.';
COMMENT ON COLUMN public.notice_independent_refs.category IS '참조 종류: order-plan, pre-specification, other.';
COMMENT ON COLUMN public.notice_independent_refs.position IS '해당 공고와 종류 안에서 발견한 순서. 0부터 시작한다.';
COMMENT ON COLUMN public.notice_independent_refs.triggers IS '해당 번호를 발견한 상세 페이지 클릭 요소의 위치·라벨·값 등을 담은 JSON 배열.';

COMMENT ON TABLE public.notice_relations IS '상세 페이지에서 직접 발견한 공고 관계. 한 관계를 양쪽 방향의 두 행으로 저장한다.';
COMMENT ON COLUMN public.notice_relations.source_key IS '관계의 출발 공고를 가리키는 notices.key.';
COMMENT ON COLUMN public.notice_relations.related_key IS '출발 공고에서 직접 발견한 관련 공고의 notices.key.';

COMMENT ON TABLE public.collection_jobs IS '수동·자동 수집 작업의 상태와 최종 결과를 보존한다.';
COMMENT ON COLUMN public.collection_jobs.state IS '작업 진행 단계, 건수, 오류와 공고별 결과를 담은 JSON.';
COMMENT ON TABLE public.collection_lock IS '수집 작업 하나만 실행하기 위한 만료 가능한 DB 임대 잠금.';
COMMENT ON COLUMN public.collection_lock.token IS '이전 실행자가 새 작업의 잠금을 해제하지 못하게 하는 소유 토큰.';
