import type { ModalCapture, ScrapedDetail, StructuredField, StructuredTable } from "./detail-page";
import { fieldText } from "./field-value";
import { contentSections } from "./content-sections";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./json-store";

export type IndependentDetail = {
  schemaVersion: 2 | 3 | 4 | 5;
  number: string;
  title: string | null;
  sections?: ScrapedDetail["sections"];
  fields?: StructuredField[];
  tables?: StructuredTable[];
  attachments?: ScrapedDetail["attachments"];
  capturedAt: string;
  settling?: ModalCapture["settling"];
  sourceNoticeKey: string;
  trigger?: ModalCapture["trigger"];
};

export type StructuredNoticeDetail = {
  detail: ScrapedDetail;
  orderPlanNumbers: string[];
  preSpecificationNumbers: string[];
  otherDetailNumbers: string[];
  orderPlans: IndependentDetail[];
  preSpecifications: IndependentDetail[];
  otherDetails: IndependentDetail[];
  independentTriggers: { number: string; trigger: ModalCapture["trigger"] }[];
  warnings: string[];
};

/** 클릭 값에서 차세대 나라장터 번호만 판별하며 차수가 있으면 함께 유지합니다. */
const numberedTrigger = (value: string) => {
  const number = value.replace(/\s+/g, "");
  return /^R\d{2}(?:BK|TA|DD|BD)\d{8}(?:-\d{3})?$/.test(number) ? number : null;
};

/** 현재 공고와 같은 번호의 모달이 별도 파일로 중복 저장되는 것을 막습니다. */
const isCurrentNotice = (number: string, key: string) => {
  const [encodedNumber, encodedOrder] = key.split("--");
  const current = `${decodeURIComponent(encodedNumber)}-${decodeURIComponent(encodedOrder)}`;
  return number === current || number === decodeURIComponent(encodedNumber);
};

// 값이 없는 필드와 표는 내용으로 세지 않되, 연결된 모달의 위치 정보는 보존합니다.
const hasFieldContent = (fields: StructuredField[]) => fields.some((field) => Boolean(fieldText(field.value)) ||
  hasTableContent(field.tables ?? []));
const hasTableContent = (tables: StructuredTable[]) => tables.some((table) =>
  [...table.headerRows, ...table.bodyRows].some((row) => row.some((cell) => Boolean(cell.value?.trim()))));
const hasContent = (fields: StructuredField[], tables: StructuredTable[]) =>
  hasFieldContent(fields) || hasTableContent(tables);
/** 독립 표와 필드에 연결된 표를 각각 한 번씩 집계할 목록으로 만듭니다. */
const allTables = (fields: StructuredField[], tables: StructuredTable[]): StructuredTable[] =>
  [...tables, ...fields.flatMap((field) => field.tables ?? [])];

/**
 * 클릭 출처의 번호와 최상위 섹션을 기준으로 수집된 모달의 저장 위치를 결정합니다.
 * @param key 현재 공고의 번호와 차수로 만든 저장 키
 * @param detail 수집 직후의 상세 자료
 * @returns 섹션에 연결한 상세와 별도 저장할 자료 및 분류 경고
 */
export function structureNoticeDetail(key: string, detail: ScrapedDetail): StructuredNoticeDetail {
  const orderPlans: IndependentDetail[] = [];
  const preSpecifications: IndependentDetail[] = [];
  const otherDetails: IndependentDetail[] = [];
  const orderPlanNumbers: string[] = [];
  const preSpecificationNumbers: string[] = [];
  const otherDetailNumbers: string[] = [];
  const independentTriggers: StructuredNoticeDetail["independentTriggers"] = [];
  const sections = detail.sections?.map((section) => ({ ...section, details: [...(section.details || [])] }));
  const modalCaptures: ModalCapture[] = [];
  const warnings: string[] = [];
  // Preserve an empty section when a modal belonging to it could not be linked.
  // Such a section is not confirmed empty, even if its visible fields have no values.
  const unresolvedSectionTitles = new Set<string>();
  const sectionByModalTitle = new Map<string, Set<number>>();
  for (const original of [...(detail.modalCaptures || []), ...(detail.baseAmountCaptures || []),
    ...(detail.changeNoticeCaptures || [])]) {
    const sectionHint = original.trigger.sectionHint;
    const capture: ModalCapture = { ...original, trigger: { ...original.trigger }, modal: { ...original.modal } };
    delete capture.modal.html;
    delete capture.modal.text;
    const title = capture.modal.title;
    const number = numberedTrigger(capture.trigger.value);

    // 번호가 있는 클릭은 현재 공고의 중복을 건너뛰고 나머지를 독립 상세 후보로 분류합니다.
    if (number) {
      if (isCurrentNotice(number, key)) continue;
      independentTriggers.push({ number, trigger: capture.trigger });
      const entity: IndependentDetail = { schemaVersion: 5, number, title,
        sections: contentSections(capture.modal, title || "미분류"),
        attachments: capture.modal.attachments || [], capturedAt: detail.capturedAt || new Date().toISOString(),
        settling: capture.settling, sourceNoticeKey: key, trigger: capture.trigger };
      const stage = number.slice(3, 5);
      const [numbers, entities] = stage === "DD" ? [orderPlanNumbers, orderPlans] :
        stage === "BD" ? [preSpecificationNumbers, preSpecifications] : [otherDetailNumbers, otherDetails];
      if (!numbers.includes(number)) { numbers.push(number); entities.push(entity); }
      continue;
    }

    // 하위 모달의 내부 sectionHint 대신 부모가 속한 최상위 섹션을 사용합니다.
    const parentTitle = capture.trigger.parentModalTitle;
    const owners = parentTitle ? [...(sectionByModalTitle.get(parentTitle) || [])] :
      sections?.flatMap((section, index) => section.title === sectionHint ? [index] : []) || [];
    if (owners.length !== 1 || !sections) {
      warnings.push(`${key}: ${title || capture.trigger.label}의 소속 섹션을 확인할 수 없습니다.`);
      if (sectionHint) unresolvedSectionTitles.add(sectionHint);
      modalCaptures.push(capture);
      continue;
    }
    const owner = owners[0];
    sections[owner].details.push({ title: title || capture.trigger.label,
      ...(capture.modal.sections ? { sections: capture.modal.sections } :
        { fields: capture.modal.fields || [], tables: capture.modal.tables || [] }),
      attachments: capture.modal.attachments || [], trigger: capture.trigger });
    if (title) {
      const titleOwners = sectionByModalTitle.get(title) || new Set<number>();
      titleOwners.add(owner);
      sectionByModalTitle.set(title, titleOwners);
    }
    if (!contentSections(capture.modal).some((section) => hasContent(section.fields, section.tables)))
      warnings.push(`${key}: ${title || capture.trigger.label}에 저장할 구조화된 값이 없습니다.`);
  }
  const nonemptySections = sections?.filter((section) =>
    hasContent(section.fields, section.tables) ||
    section.details.length > 0 ||
    unresolvedSectionTitles.has(section.title));
  const structured: ScrapedDetail = { ...detail, sections: nonemptySections, modalCaptures };
  if (structured.summary && nonemptySections) {
    structured.summary = {
      ...structured.summary,
      sectionCount: nonemptySections.length,
      fieldCount: nonemptySections.reduce((count, section) => count + section.fields.length, 0),
      nonemptyFieldCount: nonemptySections.reduce((count, section) =>
        count + section.fields.filter((field) => fieldText(field.value) !== null).length, 0),
      tableCount: nonemptySections.reduce((count, section) =>
        count + allTables(section.fields, section.tables).length, 0),
      tableRowCount: nonemptySections.reduce((count, section) =>
        count + allTables(section.fields, section.tables).reduce((rows, table) => rows + table.bodyRows.length, 0), 0)
    };
  }
  delete structured.baseAmountCaptures;
  delete structured.changeNoticeCaptures;
  delete structured.text;
  return { detail: structured, orderPlanNumbers, preSpecificationNumbers, otherDetailNumbers,
    orderPlans, preSpecifications, otherDetails, independentTriggers, warnings };
}

/**
 * 번호가 이미 저장된 독립 상세는 덮어쓰지 않고 새 번호만 파일로 기록합니다.
 * @param dataDir 공고와 독립 상세 파일을 담는 데이터 디렉터리
 * @param structured 분류가 끝난 상세와 독립 저장 후보
 * @returns 모든 새 독립 파일의 기록이 끝났을 때 완료되는 Promise
 */
export async function saveIndependentDetails(dataDir: string, structured: StructuredNoticeDetail): Promise<void> {
  for (const [folder, entities] of [["order-plans", structured.orderPlans],
    ["pre-specifications", structured.preSpecifications], ["independent-details", structured.otherDetails]] as const) {
    for (const entity of entities) {
      if (folder === "independent-details") {
        const match = /^(R\d{2}BK\d{8})-(\d{3})$/.exec(entity.number);
        if (match) {
          const noticePath = join(dataDir, "notices", `${match[1]}--${match[2]}.json`);
          try {
            const notice = await readJson<{ detail?: ScrapedDetail | null }>(noticePath);
            if (notice.detail) continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      const path = join(dataDir, folder, `${entity.number}.json`);
      // 현재 형식으로 수집한 값은 유지하고 이전 형식만 갱신합니다.
      try { if ((await readJson<IndependentDetail>(path)).schemaVersion === 5) continue; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeJsonAtomic(path, entity);
    }
  }
}
