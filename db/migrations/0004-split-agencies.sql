-- 기존 행을 채우지 않고 기관별 요약 컬럼을 추가합니다.
-- 새 데이터베이스에서는 schema.sql이 두 컬럼을 생성합니다.
DO $$
BEGIN
  IF to_regclass('public.notices') IS NOT NULL THEN
    ALTER TABLE public.notices ADD COLUMN IF NOT EXISTS demand_agency text;
    ALTER TABLE public.notices ADD COLUMN IF NOT EXISTS notice_agency text;
    DROP INDEX IF EXISTS public.notices_agency_idx;
    ALTER TABLE public.notices DROP COLUMN IF EXISTS agency;
  END IF;
END $$;
