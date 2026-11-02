-- 동일 첨부의 현재 성공 본문만 보관하며 실행 이력에는 본문을 남기지 않습니다.
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.attachment_extraction_runs'::regclass AND attname='pages' AND NOT attisdropped) THEN
  -- 소유권과 같은 잠금 순서를 지켜 구 작업기 완료 처리와 교착하지 않습니다.
  PERFORM id FROM public.attachment_extraction_worker_lease WHERE id=1 FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.attachment_extraction_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp())
   OR EXISTS(SELECT 1 FROM public.attachment_extraction_runs WHERE status='processing') THEN
   RAISE EXCEPTION 'PDF 작업기가 실행 중입니다. 기존 작업기 종료 후 마이그레이션을 적용하세요.';
  END IF;
  LOCK TABLE public.attachment_documents IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.attachment_extraction_runs IN ACCESS EXCLUSIVE MODE;
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.attachment_document_contents (
 document_id uuid PRIMARY KEY REFERENCES public.attachment_documents(id),
 run_id uuid NOT NULL,
 pages jsonb NOT NULL CHECK(jsonb_typeof(pages)='array' AND jsonb_array_length(pages)>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(run_id,document_id) REFERENCES public.attachment_extraction_runs(id,document_id)
);

DO $$
DECLARE chosen record;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.attachment_extraction_runs'::regclass AND attname='pages' AND NOT attisdropped) THEN
  FOR chosen IN
   SELECT d.id AS document_id,r.id AS run_id,r.pages FROM public.attachment_documents d
   JOIN LATERAL(SELECT r.id,r.pages FROM public.attachment_extraction_runs r
    WHERE r.document_id=d.id AND r.status='completed' AND r.character_count>0 AND jsonb_array_length(r.pages)>0
    ORDER BY (r.id=d.last_success_run_id) DESC NULLS LAST,r.finished_at DESC NULLS LAST,r.requested_at DESC,r.id DESC LIMIT 1) r ON true
  LOOP
   INSERT INTO public.attachment_document_contents(document_id,run_id,pages)
    VALUES(chosen.document_id,chosen.run_id,chosen.pages) ON CONFLICT(document_id) DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM public.attachment_document_contents c WHERE c.document_id=chosen.document_id
    AND c.run_id=chosen.run_id AND c.pages=chosen.pages) THEN
    RAISE EXCEPTION '본문 이관 검증이 실패했습니다: %',chosen.document_id;
   END IF;
   UPDATE public.attachment_documents SET last_success_run_id=chosen.run_id WHERE id=chosen.document_id;
  END LOOP;
  UPDATE public.attachment_documents d SET last_success_run_id=NULL WHERE last_success_run_id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM public.attachment_document_contents c WHERE c.document_id=d.id);
  -- 이관과 본문 일치 검증이 성공한 같은 트랜잭션에서만 과거 사본을 제거합니다.
  ALTER TABLE public.attachment_extraction_runs DROP COLUMN pages;
 END IF;
END $$;
COMMENT ON TABLE public.attachment_document_contents IS '첨부 문서별 현재 성공 본문 한 건. 재추출 성공 시 교체하며 실행 이력에 본문을 중복 저장하지 않는다.';
