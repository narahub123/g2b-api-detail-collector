-- 기존 독립 상세와 참조를 보존하면서 개찰 분류를 허용합니다.
DO $$
BEGIN
  IF to_regclass('public.independent_details') IS NOT NULL THEN
    ALTER TABLE public.independent_details DROP CONSTRAINT IF EXISTS independent_details_category_check;
    ALTER TABLE public.independent_details ADD CONSTRAINT independent_details_category_check
      CHECK (category IN ('order-plan', 'pre-specification', 'other', 'opening'));
  END IF;
  IF to_regclass('public.notice_independent_refs') IS NOT NULL THEN
    ALTER TABLE public.notice_independent_refs DROP CONSTRAINT IF EXISTS notice_independent_refs_category_check;
    ALTER TABLE public.notice_independent_refs ADD CONSTRAINT notice_independent_refs_category_check
      CHECK (category IN ('order-plan', 'pre-specification', 'other', 'opening'));
  END IF;
END $$;
