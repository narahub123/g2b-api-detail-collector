-- 주소 변경은 문서 버전으로 구분하고 실행의 원본 버전과 무효화 사유는 보존합니다.
DO $$ BEGIN
  PERFORM id FROM public.attachment_extraction_worker_lease WHERE id=1 FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.attachment_extraction_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM public.attachment_extraction_runs WHERE status='processing') THEN
    RAISE EXCEPTION 'PDF 작업기를 종료한 뒤 첨부 버전 스키마를 적용하세요.';
  END IF;
  IF to_regclass('public.detail_collection_worker_lease') IS NOT NULL THEN
    PERFORM id FROM public.detail_collection_worker_lease WHERE id=1 FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.detail_collection_worker_lease WHERE owner_token IS NOT NULL AND expires_at>clock_timestamp()) THEN
      RAISE EXCEPTION '상세 소비기를 종료한 뒤 첨부 버전 스키마를 적용하세요.';
    END IF;
  END IF;
END $$;
ALTER TABLE public.attachment_documents ADD COLUMN IF NOT EXISTS attachment_revision bigint NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.attachment_extraction_runs'::regclass
    AND attname='attachment_revision' AND NOT attisdropped) THEN
    ALTER TABLE public.attachment_extraction_runs ADD COLUMN attachment_revision bigint NOT NULL DEFAULT 1;
    -- 전환 전에 이미 주소가 달라진 이력은 현재 문서 버전으로 재사용하지 않습니다.
    UPDATE public.attachment_extraction_runs r SET attachment_revision=0
      FROM public.attachment_documents d WHERE d.id=r.document_id AND r.attachment_url<>d.attachment_url;
  END IF;
END $$;
ALTER TABLE public.attachment_extraction_runs ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
ALTER TABLE public.attachment_extraction_runs ADD COLUMN IF NOT EXISTS invalidation_reason text;
CREATE INDEX IF NOT EXISTS attachment_runs_version_history_idx
  ON public.attachment_extraction_runs(document_id,attachment_revision,extractor_version)
  WHERE invalidated_at IS NULL;
