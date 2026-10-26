-- 기존 행을 유지하며 모호한 number 컬럼을 의미가 드러나는 이름으로 바꿉니다.
-- 새 데이터베이스에서는 이전 이름의 컬럼이 없으므로 아무 작업도 하지 않습니다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notices' AND column_name = 'number'
  ) THEN
    ALTER TABLE public.notices RENAME COLUMN number TO notice_number;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'independent_details' AND column_name = 'number'
  ) THEN
    ALTER TABLE public.independent_details RENAME COLUMN number TO detail_key;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notice_independent_refs' AND column_name = 'number'
  ) THEN
    ALTER TABLE public.notice_independent_refs RENAME COLUMN number TO detail_key;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = to_regclass('public.notices') AND conname = 'notices_number_notice_order_key'
  ) THEN
    ALTER TABLE public.notices RENAME CONSTRAINT notices_number_notice_order_key
      TO notices_notice_number_notice_order_key;
  END IF;

  IF to_regclass('public.notice_independent_refs_number_idx') IS NOT NULL THEN
    ALTER INDEX public.notice_independent_refs_number_idx
      RENAME TO notice_independent_refs_detail_key_idx;
  END IF;
END $$;
