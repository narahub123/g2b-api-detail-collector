/** 서버 오류 직렬화에 의존하지 않는 화면·작업기 공통 단계 이름입니다. */
export const extractionStages = { attachment: '첨부 확인', download: '다운로드', opening: '문서 열기', extracting: '텍스트 추출', saving: '결과 저장' } as const;
export type ExtractionStage = keyof typeof extractionStages;
