import { describe, expect, it } from "vitest";
import { buildNoticeGraph } from "./notice-graph";

describe("buildNoticeGraph", () => {
  it("keeps each capture's trigger and modal separate, including unfamiliar modal titles", () => {
    const raw = { key: "A--000", detail: { modalCaptures: [
      { trigger: { label: "첫 버튼", value: "x" }, modal: { title: "새로운 종류", fields: [{ label: "항목", value: "값" }], tables: [] }, settling: { status: "settled" } },
      { trigger: { label: "둘째 버튼" }, modal: { title: "새로운 종류", fields: [], tables: [[1]] }, settling: { status: "timeout" } }
    ] } };
    const graph = buildNoticeGraph(raw, "A--000.json", ["A--000.json"]);
    expect(graph.nodes.filter((node) => node.type === "trigger")).toHaveLength(2);
    expect(graph.nodes.filter((node) => node.type === "modal")).toHaveLength(2);
    expect(graph.links.filter((link) => link.type === "opens")).toEqual([
      { source: "trigger:0", target: "modal:0", type: "opens", label: "열린 모달" },
      { source: "trigger:1", target: "modal:1", type: "opens", label: "열린 모달" }
    ]);
    expect(graph.nodes.find((node) => node.id === "modal:1")?.details).toMatchObject({ 상태: "timeout", 표: "1개" });
  });

  it("shows explicit related keys even when a referenced file is absent", () => {
    const graph = buildNoticeGraph({ key: "A--000", relatedNoticeKeys: ["A--001", "A--002", "A--001"] }, "A--000.json", ["A--000.json", "A--001.json"]);
    expect(graph.nodes.filter((node) => node.type === "related").map((node) => [node.label, node.status])).toEqual([
      ["A--001", "saved"], ["A--002", "referenced"]
    ]);
    expect(graph.links.filter((link) => link.type === "related")).toHaveLength(2);
  });

  it("connects modal details to an identifier only when its named value matches exactly", () => {
    const raw = { key: "A--000", api: { orderPlanUntyNo: "P-1", bfSpecRgstNo: "S-1" },
      detail: { fields: { 발주계획번호: "P-1", 사전규격등록번호: "S-1" }, modalCaptures: [
        { trigger: { label: "발주계획번호", value: "P-1" }, modal: { title: "계획 상세", fields: [{ label: "발주계획번호", value: "P-1" }] } },
        { trigger: { label: "사전규격등록번호", value: "S-1" }, modal: { title: "다른 상세", fields: [{ label: "사전규격등록번호", value: "S-2" }] } }
      ] } };
    const graph = buildNoticeGraph(raw, "A--000.json", ["A--000.json"]);
    expect(graph.nodes.find((node) => node.id === "identifier:plan:P-1")?.sourcePaths).toEqual(["api.orderPlanUntyNo", "detail.fields.발주계획번호", "detail.modalCaptures[0].modal.fields[0].value"]);
    expect(graph.nodes.some((node) => node.id === "identifier:spec:S-1")).toBe(true);
    expect(graph.links.filter((link) => link.type === "modalIdentifier")).toEqual([
      { source: "modal:0", target: "identifier:plan:P-1", type: "modalIdentifier", label: "모달 필드" },
      { source: "modal:1", target: "identifier:spec:S-2", type: "modalIdentifier", label: "모달 필드" }
    ]);
    expect(graph.links.some((link) => link.source === "modal:1" && link.target === "identifier:spec:S-1")).toBe(false);
  });

  it("does not invent relationships for missing or unrelated values", () => {
    const graph = buildNoticeGraph({ key: "A--000", detail: { fields: { 사전규격미공개사유: "사유", 발주계획번호: "" }, modalCaptures: [] } }, "A--000.json", ["A--000.json", "A--001.json"]);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.links).toEqual([]);
  });
});
