export type GraphNodeType = "notice" | "related" | "identifier" | "trigger" | "modal";
export type GraphLinkType = "related" | "identifies" | "capture" | "opens" | "modalIdentifier";
export type NoticeGraphNode = {
  id: string;
  type: GraphNodeType;
  label: string;
  status?: "selected" | "saved" | "referenced" | "identifierOnly" | "modalCaptured";
  sourcePaths: string[];
  details: Record<string, string>;
};
export type NoticeGraphLink = { source: string; target: string; type: GraphLinkType; label: string };
export type NoticeGraph = { nodes: NoticeGraphNode[]; links: NoticeGraphLink[] };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const asText = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const display = (value: unknown): string => typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);

const identifiers = [
  { kind: "plan", label: "발주계획번호", apiKey: "orderPlanUntyNo" },
  { kind: "spec", label: "사전규격등록번호", apiKey: "bfSpecRgstNo" }
] as const;

export function buildNoticeGraph(raw: unknown, file: string, availableFiles: readonly string[]): NoticeGraph {
  const record = asRecord(raw);
  const detail = asRecord(record?.detail);
  const api = asRecord(record?.api);
  const normalized = asRecord(record?.normalized);
  const title = asText(api?.bidNtceNm) || asText(asRecord(normalized?.title)?.value);
  const noticeKey = asText(record?.key) || file.replace(/\.json$/, "");
  const nodes: NoticeGraphNode[] = [{ id: "notice", type: "notice", label: noticeKey, status: "selected",
    sourcePaths: ["key"], details: { 파일: file, 공고명: title || "", 키: noticeKey } }];
  const links: NoticeGraphLink[] = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const related = asArray(record?.relatedNoticeKeys);
  related.forEach((value, index) => {
    const key = asText(value);
    if (!key || key === noticeKey) return;
    const id = `related:${key}`;
    if (nodeById.has(id)) return;
    const saved = availableFiles.includes(`${key}.json`);
    const node: NoticeGraphNode = { id, type: "related", label: key, status: saved ? "saved" : "referenced",
      sourcePaths: [`relatedNoticeKeys[${index}]`], details: { 키: key, 로컬파일: saved ? "있음" : "없음" } };
    nodes.push(node); nodeById.set(id, node);
    links.push({ source: "notice", target: id, type: "related", label: "관련 공고 참조" });
  });

  function addIdentifier(kind: typeof identifiers[number], value: string, path: string, from: string) {
    const id = `identifier:${kind.kind}:${value}`;
    let node = nodeById.get(id);
    if (!node) {
      node = { id, type: "identifier", label: `${kind.label} ${value}`, status: "identifierOnly",
        sourcePaths: [], details: { 구분: kind.label, 값: value, 수집상태: "식별자만 확인" } };
      nodes.push(node); nodeById.set(id, node);
    }
    if (!node.sourcePaths.includes(path)) node.sourcePaths.push(path);
    if (from === "notice") {
      if (!links.some((link) => link.type === "identifies" && link.target === id))
        links.push({ source: "notice", target: id, type: "identifies", label: kind.label });
    } else {
      node.status = "modalCaptured";
      node.details.수집상태 = "모달 필드에도 확인";
      if (!links.some((link) => link.source === from && link.target === id))
        links.push({ source: from, target: id, type: "modalIdentifier", label: "모달 필드" });
    }
  }

  for (const kind of identifiers) {
    const apiValue = asText(api?.[kind.apiKey]);
    const detailValue = asText(asRecord(detail?.fields)?.[kind.label]);
    if (apiValue) addIdentifier(kind, apiValue, `api.${kind.apiKey}`, "notice");
    if (detailValue) addIdentifier(kind, detailValue, `detail.fields.${kind.label}`, "notice");
  }

  asArray(detail?.modalCaptures).forEach((value, index) => {
    const capture = asRecord(value);
    if (!capture) return;
    const trigger = asRecord(capture.trigger);
    const modal = asRecord(capture.modal);
    const settling = asRecord(capture.settling);
    const base = `detail.modalCaptures[${index}]`;
    const triggerId = `trigger:${index}`;
    const modalId = `modal:${index}`;
    if (trigger) {
      const node: NoticeGraphNode = { id: triggerId, type: "trigger", label: `${asText(trigger.label) || asText(trigger.value) || "트리거"} · #${index + 1}`,
        sourcePaths: [`${base}.trigger`], details: { 라벨: display(trigger.label), 값: display(trigger.value), 위치: display(trigger.sectionHint) } };
      nodes.push(node); nodeById.set(triggerId, node);
      links.push({ source: "notice", target: triggerId, type: "capture", label: "수집 트리거" });
    }
    if (!modal) return;
    const modalFields = asArray(modal.fields);
    const modalTables = asArray(modal.tables);
    const node: NoticeGraphNode = { id: modalId, type: "modal", label: `${asText(modal.title) || "모달"} · #${index + 1}`,
      sourcePaths: [`${base}.modal`, ...(settling ? [`${base}.settling`] : [])],
      details: { 제목: display(modal.title), 상태: display(settling?.status), 필드: `${modalFields.length}개`, 표: `${modalTables.length}개` } };
    nodes.push(node); nodeById.set(modalId, node);
    links.push({ source: trigger ? triggerId : "notice", target: modalId, type: trigger ? "opens" : "capture", label: trigger ? "열린 모달" : "수집 모달" });
    modalFields.forEach((field, fieldIndex) => {
      const item = asRecord(field);
      const fieldValue = asText(item?.value);
      const kind = identifiers.find((entry) => entry.label === item?.label);
      if (kind && fieldValue) addIdentifier(kind, fieldValue, `${base}.modal.fields[${fieldIndex}].value`, modalId);
    });
  });

  return { nodes, links };
}
