import type { NormalizedNotice, ValidationIssue } from "./normalize";

export function validateNotice(value: NormalizedNotice): ValidationIssue[] {
  const issues = [...value.validationIssues];
  if (!value.number || !value.order) issues.push({ field: "identity", message: "공고 식별자가 없습니다." });
  if (!value.title.value) issues.push({ field: "title", message: "공고명이 없습니다." });
  return issues;
}
