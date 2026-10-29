import { pdfText } from "./contract";
import { bounds, multiply, point } from "./geometry";
import type { Matrix, Rect } from "./geometry";
export { pathRectangles } from "./geometry";

export const READING_ORDER_VERSION = "reading-order-v1";
type TextItem = { str: string; width: number; height: number; transform: number[]; hasEOL?: boolean };
type Positioned = Rect & { text: string; index: number; font: number; baseline: number; source: TextItem };
type Block = Rect & { text: string; count: number; positioned?: Positioned };

/** 글자 크기에 비례하는 간격 판단값을 얻어 고정 페이지 크기에 의존하지 않습니다. */
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 10;
}

/** 텍스트의 기준점과 네 꼭짓점을 표시 좌표로 바꿔 페이지 회전을 반영합니다. */
function position(item: TextItem, index: number, viewport: Matrix): Positioned {
  const [a, b, c, d, x, y] = item.transform;
  const norm = Math.hypot(a, b) || 1, vertical = Math.hypot(c, d) || 1;
  const dx = a / norm * item.width, dy = b / norm * item.width;
  const ux = c / vertical * item.height, uy = d / vertical * item.height;
  const rect = bounds([[x, y], [x + dx, y + dy], [x + ux, y + uy], [x + dx + ux, y + dy + uy]]
    .map(([px, py]) => point(viewport, px, py)));
  const transform = multiply(viewport, item.transform);
  return { ...rect, text: item.str, index, font: Math.max(Math.hypot(transform[2], transform[3]), 1),
    baseline: point(viewport, x, y)[1], source: item };
}

/** 같은 줄을 좌표로 묶되 붙어 있는 글자 조각에는 불필요한 공백을 넣지 않습니다. */
function lines(items: Positioned[]): string {
  const rows: { baseline: number; font: number; items: Positioned[] }[] = [];
  for (const item of [...items].sort((a, b) => a.baseline - b.baseline || a.x - b.x || a.index - b.index)) {
    const row = rows.findLast(row => Math.abs(row.baseline - item.baseline) <= Math.min(row.font, item.font) * 0.3);
    if (row) row.items.push(item);
    else rows.push({ baseline: item.baseline, font: item.font, items: [item] });
  }
  return rows.map(row => {
    const sorted = row.items.sort((a, b) => a.x - b.x || a.index - b.index);
    let text = "";
    sorted.forEach((item, i) => {
      const previous = sorted[i - 1];
      if (previous && item.x - previous.x - previous.width > Math.max(1, Math.min(previous.font, item.font) * 0.12) &&
        !/\s$/.test(text) && !/^\s/.test(item.text)) text += " ";
      text += item.text;
    });
    return text.trimEnd();
  }).join("\n");
}

/** 두 사각형이 변을 공유할 때만 연결해 외곽 클리핑 영역을 표와 합치지 않습니다. */
function adjacent(a: Rect, b: Rect) {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return ((Math.abs(a.x + a.width - b.x) < 1.5 || Math.abs(b.x + b.width - a.x) < 1.5) && overlapY > 3) ||
    ((Math.abs(a.y + a.height - b.y) < 1.5 || Math.abs(b.y + b.height - a.y) < 1.5) && overlapX > 3);
}

/** 실제 셀 경계를 가진 표를 먼저 묶어 병합 셀과 표 안 여백이 읽기 순서를 깨지 않게 합니다. */
function tableBlocks(items: Positioned[], rectangles: Rect[]) {
  const groups: Rect[][] = [], remaining = new Set(rectangles.map((_, index) => index));
  while (remaining.size) {
    const first = remaining.values().next().value!;
    remaining.delete(first);
    const group = [rectangles[first]];
    for (let i = 0; i < group.length; i++) {
      for (const index of remaining) if (adjacent(group[i], rectangles[index])) { group.push(rectangles[index]); remaining.delete(index); }
    }
    if (group.length >= 4 && group.some(cell => Math.abs(cell.x - group[0].x) > 3) &&
      group.some(cell => Math.abs(cell.y - group[0].y) > 3)) groups.push(group);
  }
  const used = new Set<number>(), blocks: Block[] = [];
  for (const group of groups) {
    const cellItems = group.map(() => [] as Positioned[]);
    for (const item of items) {
      if (used.has(item.index)) continue;
      const x = item.x + item.width / 2, y = item.y + item.height / 2;
      const matches = group.map((cell, index) => ({ cell, index })).filter(({ cell }) =>
        x >= cell.x - 0.5 && x <= cell.x + cell.width + 0.5 && y >= cell.y - 0.5 && y <= cell.y + cell.height + 0.5)
        .sort((a, b) => a.cell.width * a.cell.height - b.cell.width * b.cell.height);
      if (matches[0]) { cellItems[matches[0].index].push(item); used.add(item.index); }
    }
    if (!cellItems.some(cell => cell.length)) continue;
    // 셀의 시작 행을 기준으로 정렬해 세로 가운데에 놓인 병합 셀의 레이블을 먼저 읽습니다.
    const rows: { y: number; cells: { rect: Rect; text: string }[] }[] = [];
    group.map((rect, index) => ({ rect, text: lines(cellItems[index]) })).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
      .forEach(cell => {
        const row = rows.find(row => Math.abs(row.y - cell.rect.y) < 1.5);
        if (row) row.cells.push(cell); else rows.push({ y: cell.rect.y, cells: [cell] });
      });
    blocks.push({ ...bounds(group.flatMap(cell => [[cell.x, cell.y], [cell.x + cell.width, cell.y + cell.height]] as [number, number][])),
      text: rows.map(row => row.cells.sort((a, b) => a.rect.x - b.rect.x).map(cell => cell.text).join("\t").trimEnd()).join("\n"),
      count: cellItems.reduce((sum, cell) => sum + cell.length, 0) });
  }
  return { used, blocks };
}

/** 영역 사이의 빈 공간을 찾아 단 또는 전폭 제목 아래의 본문 경계를 나눕니다. */
function gaps(blocks: Block[], axis: "x" | "y", minimum: number) {
  const size = axis === "x" ? "width" : "height";
  const ranges = blocks.map(block => [block[axis], block[axis] + block[size]]).sort((a, b) => a[0] - b[0]);
  const found: { middle: number; size: number }[] = [];
  let end = ranges[0]?.[1] ?? 0;
  for (const [start, stop] of ranges.slice(1)) {
    if (start - end >= minimum) found.push({ middle: (start + end) / 2, size: start - end });
    end = Math.max(end, stop);
  }
  return found.sort((a, b) => b.size - a.size);
}

/** 표는 단일 블록으로 유지하며 단은 왼쪽에서 오른쪽, 본문은 위에서 아래로 읽습니다. */
function ordered(blocks: Block[], font: number, depth = 0): Block[][] {
  if (blocks.length < 2) return [blocks];
  if (depth < 12) {
    for (const gap of gaps(blocks, "x", Math.max(18, font * 2))) {
      const left = blocks.filter(block => block.x < gap.middle), right = blocks.filter(block => block.x >= gap.middle);
      const span = (values: Block[]) => Math.max(...values.map(b => b.y + b.height)) - Math.min(...values.map(b => b.y));
      // 표의 열이나 단어 사이 공백을 본문 단으로 분리하지 않도록 충분한 세로 범위를 요구합니다.
      if (left.reduce((sum, b) => sum + b.count, 0) >= 3 && right.reduce((sum, b) => sum + b.count, 0) >= 3 &&
        span(left) >= font * 5 && span(right) >= font * 5) {
        return [...ordered(left, font, depth + 1), ...ordered(right, font, depth + 1)];
      }
    }
    const horizontal = gaps(blocks, "y", font * 0.65)[0];
    if (horizontal) return [...ordered(blocks.filter(block => block.y < horizontal.middle), font, depth + 1),
      ...ordered(blocks.filter(block => block.y >= horizontal.middle), font, depth + 1)];
  }
  // 줄 안의 작은 글자 크기 차이는 같은 줄로 묶고 표 블록은 쪼개지 않습니다.
  return [[...blocks].sort((a, b) => Math.abs(a.y - b.y) < font * 0.3 ? a.x - b.x : a.y - b.y)];
}

/** PDF 내부 기록 순서 대신 표시 좌표와 셀 경계로 일반 가로쓰기 본문의 순서를 복원합니다. */
export function readingOrderText(source: TextItem[], viewport: Matrix, rectangles: Rect[] = []) {
  const items = source.map((item, index) => position(item, index, viewport)).filter(item => item.text.trim());
  if (!items.length) return "";
  // 좌표가 잘못되거나 세로쓰기 중심인 문서는 임의로 재배치하지 않고 원래 추출 순서를 남깁니다.
  if (items.some(item => ![item.x, item.y, item.width, item.height].every(Number.isFinite)) ||
    items.filter(item => { const m = multiply(viewport, item.source.transform); return Math.abs(m[1]) > Math.abs(m[0]) * 0.2; }).length > items.length * 0.2)
    return pdfText(source);
  const font = median(items.map(item => item.font));
  const { used, blocks } = tableBlocks(items, rectangles);
  // 일반 텍스트는 줄별로 묶기 전에 단을 구분해야 좌우 문장이 같은 줄로 합쳐지지 않습니다.
  const loose = items.filter(item => !used.has(item.index));
  const all: Block[] = [...blocks, ...loose.map(item => ({ ...item, count: 1, positioned: item }))];
  // 단 분할의 말단에서 같은 줄을 합치기 위해 텍스트 블록을 식별할 수 있게 처리합니다.
  return orderedWithLines(all, font).replaceAll("\u0000", "").trimEnd();
}

/** 단·전폭 블록 경계를 유지하면서 일반 텍스트 행만 한 줄로 결합합니다. */
function orderedWithLines(blocks: Block[], font: number): string {
  const sequence = ordered(blocks, font);
  const chunks: string[] = []; let pending: Positioned[] = [];
  /** 표 또는 단 경계를 넘기 전에 모인 텍스트 행을 출력합니다. */
  const flush = () => { if (pending.length) { chunks.push(lines(pending)); pending = []; } };
  for (const region of sequence) {
    for (const block of region) {
      const item = block.positioned;
      if (item) pending.push(item);
      else { flush(); chunks.push(block.text); }
    }
    // 단 경계를 넘어서 좌표로 다시 정렬하면 올바른 단 순서가 되돌려지므로 반드시 끊습니다.
    flush();
  }
  flush();
  return chunks.join("\n");
}
