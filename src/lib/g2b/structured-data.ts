import type { ModalCapture, ScrapedDetail, StructuredField, StructuredTable } from "./detail-page";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./json-store";

export type IndependentDetail = {
  schemaVersion: 1;
  number: string;
  title: string | null;
  fields: StructuredField[];
  tables: StructuredTable[];
  capturedAt: string;
  settling?: ModalCapture["settling"];
  sourceNoticeKey: string;
};

export type StructuredNoticeDetail = {
  detail: ScrapedDetail;
  orderPlanNumbers: string[];
  preSpecificationNumbers: string[];
  orderPlans: IndependentDetail[];
  preSpecifications: IndependentDetail[];
  warnings: string[];
};

const safeNumber = (value: string | null | undefined) => value?.trim().match(/^[A-Za-z0-9_-]+$/)?.[0] || null;
const fieldValue = (capture: ModalCapture, label: string) =>
  capture.modal.fields.find((field) => field.label === label)?.value?.trim() || null;

function matchesNotice(capture: ModalCapture, key: string): boolean {
  const [encodedNumber, encodedOrder] = key.split("--");
  const number = decodeURIComponent(encodedNumber);
  const order = decodeURIComponent(encodedOrder);
  const capturedNumber = fieldValue(capture, "입찰공고번호")?.replace(/\s+/g, "");
  const capturedOrder = fieldValue(capture, "입찰공고차수");
  if (capturedNumber && capturedNumber !== number && capturedNumber !== `${number}-${order}`) return false;
  return !capturedOrder || capturedOrder === order;
}

// A section is empty only when neither its own data nor linked modal details have values.
// Header-only tables and fields with null/blank values do not count as content.
const hasFieldContent = (fields: StructuredField[]) => fields.some((field) => Boolean(field.value?.trim()));
const hasTableContent = (tables: StructuredTable[]) => tables.some((table) =>
  table.bodyRows.some((row) => row.some((cell) => Boolean(cell.value?.trim()))));
const hasContent = (fields: StructuredField[], tables: StructuredTable[]) =>
  hasFieldContent(fields) || hasTableContent(tables);

export function structureNoticeDetail(key: string, detail: ScrapedDetail): StructuredNoticeDetail {
  const orderPlans: IndependentDetail[] = [];
  const preSpecifications: IndependentDetail[] = [];
  const orderPlanNumbers: string[] = [];
  const preSpecificationNumbers: string[] = [];
  const sections = detail.sections?.map((section) => ({ ...section, details: [...(section.details || [])] }));
  const modalCaptures: ModalCapture[] = [];
  const warnings: string[] = [];
  // Preserve an empty section when a modal belonging to it could not be linked.
  // Such a section is not confirmed empty, even if its visible fields have no values.
  const unresolvedSectionTitles = new Set<string>();
  for (const original of [...(detail.modalCaptures || []), ...(detail.baseAmountCaptures || []),
    ...(detail.changeNoticeCaptures || [])]) {
    const sectionHint = original.trigger.sectionHint;
    const capture: ModalCapture = { ...original, trigger: { ...original.trigger }, modal: { ...original.modal } };
    delete capture.modal.html;
    const title = capture.modal.title;
    const isPlan = title === "발주계획상세조회";
    const isPreSpec = title === "사전규격상세조회";
    const isAmount = title === "기초가격상세조회";
    const isNotice = title === "공지사항 상세";
    if (!(isPlan || isPreSpec || isAmount || isNotice)) { modalCaptures.push(capture); continue; }
    if ((isAmount || isNotice) && !matchesNotice(capture, key)) {
      warnings.push(`${key}: ${title}의 공고 식별자가 일치하지 않습니다.`);
      if (sectionHint) unresolvedSectionTitles.add(sectionHint);
      modalCaptures.push(capture);
      continue;
    }
    if (isAmount || isNotice) {
      if (!capture.modal.fields.length && !capture.modal.tables.length) {
        warnings.push(`${key}: ${title}에 구조화된 필드나 표가 없습니다.`);
        if (sectionHint) unresolvedSectionTitles.add(sectionHint);
        modalCaptures.push(capture);
        continue;
      }
      const targetTitle = isAmount ? "기초금액공개" : "공지사항";
      const owners = sections?.filter((section) => section.title === targetTitle) || [];
      if (sectionHint !== targetTitle || owners.length !== 1) {
        warnings.push(`${key}: ${title}의 소속 섹션을 확인할 수 없습니다.`);
        if (sectionHint) unresolvedSectionTitles.add(sectionHint);
        modalCaptures.push(capture);
        continue;
      }
      owners[0].details.push({ title, fields: capture.modal.fields, tables: capture.modal.tables });
      continue;
    }
    const number = safeNumber(fieldValue(capture, isPlan ? "발주계획번호" : "사전규격등록번호"));
    if (!number) {
      warnings.push(`${key}: ${title}의 고유번호가 없습니다.`);
      modalCaptures.push(capture);
      continue;
    }
    const entity: IndependentDetail = { schemaVersion: 1, number, title, fields: capture.modal.fields,
      tables: capture.modal.tables, capturedAt: detail.capturedAt || new Date().toISOString(),
      settling: capture.settling, sourceNoticeKey: key };
    if (isPlan) {
      if (!orderPlanNumbers.includes(number)) { orderPlanNumbers.push(number); orderPlans.push(entity); }
    } else if (!preSpecificationNumbers.includes(number)) {
      preSpecificationNumbers.push(number);
      preSpecifications.push(entity);
    }
  }
  const nonemptySections = sections?.filter((section) =>
    hasContent(section.fields, section.tables) ||
    section.details.some((linked) => hasContent(linked.fields, linked.tables)) ||
    unresolvedSectionTitles.has(section.title));
  const structured: ScrapedDetail = { ...detail, sections: nonemptySections, modalCaptures };
  if (structured.summary && nonemptySections) {
    structured.summary = {
      ...structured.summary,
      sectionCount: nonemptySections.length,
      fieldCount: nonemptySections.reduce((count, section) => count + section.fields.length, 0),
      nonemptyFieldCount: nonemptySections.reduce((count, section) =>
        count + section.fields.filter((field) => field.value !== null).length, 0),
      tableCount: nonemptySections.reduce((count, section) => count + section.tables.length, 0),
      tableRowCount: nonemptySections.reduce((count, section) =>
        count + section.tables.reduce((rows, table) => rows + table.bodyRows.length, 0), 0)
    };
  }
  delete structured.baseAmountCaptures;
  delete structured.changeNoticeCaptures;
  delete structured.text;
  return { detail: structured, orderPlanNumbers, preSpecificationNumbers, orderPlans, preSpecifications, warnings };
}

export async function saveIndependentDetails(dataDir: string, structured: StructuredNoticeDetail): Promise<void> {
  for (const [folder, entities] of [["order-plans", structured.orderPlans],
    ["pre-specifications", structured.preSpecifications]] as const) {
    for (const entity of entities) {
      const path = join(dataDir, folder, `${entity.number}.json`);
      let previous: IndependentDetail | null = null;
      try { previous = await readJson<IndependentDetail>(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!previous || entity.capturedAt > previous.capturedAt) await writeJsonAtomic(path, entity);
    }
  }
}
