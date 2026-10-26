import type { StructuredField, StructuredSection } from "./detail-page";
import type { StructuredTable } from "./structured-table";

type ModalContent = {
  text: string;
  title: string | null;
  fields: StructuredField[];
  tables: StructuredTable[];
  sections?: StructuredSection[];
  attachments?: { name: string; url: string }[];
};

/**
 * 모달 수집 내용의 중복 여부를 판별하는 객체를 생성합니다.
 *
 * 중복 비교에는 모달의 텍스트, 제목, 섹션, 필드, 테이블, 첨부 URL을 사용합니다.
 * 클릭 경로, DOM ID, 데이터 안정화 대기 시간 등은 비교하지 않습니다.
 *
 * 비교 기록은 이 함수를 호출할 때마다 새로 생성되므로
 * 서로 다른 수집 실행 간에 중복 판별 결과가 공유되지 않습니다.
 */
export function createModalDeduplication() {
  const contents: string[] = [];

  return {
    /**
     * 모달의 수집 내용이 이전에 확인한 내용과 동일한지 검사합니다.
     *
     * 비교 항목을 JSON 문자열로 직렬화하여 기존 기록과 비교합니다.
     * 문자열이 완전히 일치하는 경우에만 중복으로 판단합니다.
     *
     * 새로운 내용이면 비교 기록에 즉시 등록합니다.
     * 따라서 이후 동일한 내용으로 호출하면 중복으로 판단됩니다.
     *
     * @param modal 중복 여부를 확인할 모달의 수집 내용
     * @returns 이미 등록된 내용이면 true, 새로운 내용이면 false
     */
    isDuplicate(modal: ModalContent): boolean {
      const serialized = JSON.stringify({
        text: modal.text,
        title: modal.title,
        fields: modal.fields,
        tables: modal.tables,
        sections: modal.sections,
        attachments: modal.attachments,
      });
      if (contents.includes(serialized)) return true;
      contents.push(serialized);
      return false;
    },
  };
}
