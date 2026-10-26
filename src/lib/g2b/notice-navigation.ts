export type NoticeStage = "plan" | "spec" | "notice" | "opening" | "award" | "contract";
export type NavigationTarget = { stage: NoticeStage; reference?: string } | { href: string };
export type NavigationSegment = { text: string; target?: NavigationTarget };
export type OpeningReference = { number: string; triggers?: { sectionHint?: string | null; value: string; html: string }[] };
export type NavigationTargets = { currentKey: string; relatedKeys: string[]; planNumbers: string[];
  specNumbers: string[]; opening: OpeningReference[] };

/** 단계별 참조 상세의 초점 이동에 사용할 안정적인 요소 ID를 만듭니다. */
export function referenceElementId(reference: string): string {
  return `notice-reference-${reference}`;
}

/** 저장된 참조와 일치하는 번호만 이동 대상으로 해석합니다. */
function targetForNumber(value: string, targets: NavigationTargets): NavigationTarget | null {
  const compact = value.replace(/\s+/g, "");
  if (/^R\d{2}DD\d{8}$/.test(compact) && targets.planNumbers.includes(compact))
    return { stage: "plan", reference: compact };
  if (/^R\d{2}BD\d{8}$/.test(compact) && targets.specNumbers.includes(compact))
    return { stage: "spec", reference: compact };
  const bid = /^(R\d{2}BK\d{8})-(\d{3})$/.exec(compact);
  if (!bid) return null;
  const key = `${bid[1]}--${bid[2]}`;
  if (key === targets.currentKey) return { stage: "notice" };
    return targets.relatedKeys.includes(key) ? { href: `/bids/${encodeURIComponent(key)}` } : null;
}

/** 이어 붙은 공고번호 사이에 표시용 구분자를 넣고 각 이동 대상을 판별합니다. */
export function splitNavigationValue(value: string, targets: NavigationTargets): NavigationSegment[] {
  const parts: NavigationSegment[] = [];
  const numbers = /R\d{2}(?:BK\d{8}\s*-\s*\d{3}|DD\d{8}|BD\d{8})/g;
  const matches = [...value.matchAll(numbers)];
  let end = 0;
  let previousBid = false;
  for (const [index, match] of matches.entries()) {
    const start = match.index;
    const target = targetForNumber(match[0], targets);
    const isBid = /^R\d{2}BK/.test(match[0]);
    const previous = matches[index - 1];
    const next = matches[index + 1];
    const pairedBid = isBid && (
      (previous && /^R\d{2}BK/.test(previous[0]) && previous.index + previous[0].length === start) ||
      (next && /^R\d{2}BK/.test(next[0]) && start + match[0].length === next.index));
    if (!target && !pairedBid) continue;
    if (start > end) parts.push({ text: value.slice(end, start) });
    else if (isBid && previousBid) parts.push({ text: ", " });
    parts.push(target ? { text: match[0], target } : { text: match[0] });
    end = start + match[0].length;
    previousBid = isBid;
  }
  if (end < value.length) parts.push({ text: value.slice(end) });
  return parts.length ? parts : [{ text: value }];
}

/** 개찰 진행현황의 원래 행·열·값이 모두 맞는 단일 저장 상세만 선택합니다. */
export function openingTargetForCell(section: string, row: number, column: number, value: string,
  references: OpeningReference[]): NavigationTarget | null {
  if (section !== "입찰진행현황" || !value.trim()) return null;
  const matches = references.filter((reference) => reference.triggers?.some((trigger) => {
    const position = /gridViewPgst_button_(\d+)_(\d+)/.exec(trigger.html);
    return trigger.sectionHint === section && trigger.value.trim() === value.trim() &&
      position && Number(position[1]) === row && Number(position[2]) === column;
  }));
  return matches.length === 1 ? { stage: "opening", reference: matches[0].number } : null;
}
