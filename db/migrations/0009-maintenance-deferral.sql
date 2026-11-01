-- 점검 보류 작업은 완료 기준점 계산에서 제외합니다.
ALTER TABLE public.collection_jobs DROP CONSTRAINT IF EXISTS collection_jobs_status_check;
ALTER TABLE public.collection_jobs ADD CONSTRAINT collection_jobs_status_check CHECK (status IN ('running','completed','failed','interrupted','deferred'));
