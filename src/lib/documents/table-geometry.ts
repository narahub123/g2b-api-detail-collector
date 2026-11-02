import type { Rect } from "./geometry";

export type Segment = { axis: "x" | "y"; at: number; start: number; end: number };
const TOLERANCE = 1;
export const MAX_TABLE_SEGMENTS = 6000;
const MAX_GRID_TILES = 20000;
const MAX_TABLE_CELLS = 1500;

/** 근접 좌표를 한 기준점으로 모아 배경과 테두리의 작은 차이를 흡수합니다. */
function coordinates(values: number[]) {
  const result: number[] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    if (!result.length || value - result[result.length - 1] > TOLERANCE) result.push(value);
  }
  return result;
}

/** 같은 직선 위의 선 조각과 중복 테두리를 결합합니다. */
function normalize(source: Segment[]): Segment[] {
  const xs = coordinates(source.flatMap(line => line.axis === "x" ? [line.start, line.end] : [line.at]));
  const ys = coordinates(source.flatMap(line => line.axis === "y" ? [line.start, line.end] : [line.at]));
  /** 정렬된 기준 좌표에서 오차 범위 안의 대표값을 찾습니다. */
  const snap = (values: number[], value: number) => values.find(candidate => Math.abs(candidate - value) <= TOLERANCE)!;
  const lines = source.map(line => ({ axis: line.axis,
    at: snap(line.axis === "x" ? ys : xs, line.at),
    start: snap(line.axis === "x" ? xs : ys, line.start),
    end: snap(line.axis === "x" ? xs : ys, line.end) }))
    .filter(line => line.end > line.start)
    .sort((a, b) => a.axis.localeCompare(b.axis) || a.at - b.at || a.start - b.start);
  const merged: Segment[] = [];
  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (previous && previous.axis === line.axis && previous.at === line.at && line.start <= previous.end + TOLERANCE)
      previous.end = Math.max(previous.end, line.end);
    else merged.push({ ...line });
  }
  return merged;
}

/** 실제로 접하는 경계만 연결해 서로 다른 표와 내부 장식선을 분리합니다. */
function touches(a: Segment, b: Segment) {
  if (a.axis === b.axis) return a.at === b.at && a.start <= b.end && b.start <= a.end;
  return a.at >= b.start && a.at <= b.end && b.at >= a.start && b.at <= a.end;
}

/** 반복되는 행 끝점과 내부 열 경계가 있는 경우에만 열린 외곽선을 보완합니다. */
function closeOpenSides(lines: Segment[]) {
  const horizontal = lines.filter(line => line.axis === "x");
  const vertical = lines.filter(line => line.axis === "y");
  if (new Set(vertical.map(line => line.at)).size < 2 || horizontal.length < 3) return lines;
  const top = Math.min(...horizontal.map(line => line.at)), bottom = Math.max(...horizontal.map(line => line.at));
  const sides = [Math.min(...horizontal.map(line => line.start)), Math.max(...horizontal.map(line => line.end))];
  const added: Segment[] = [];
  for (const side of sides) {
    const ends = horizontal.filter(line => line.start === side || line.end === side);
    if (new Set(ends.map(line => line.at)).size >= 3 && ends.some(line => line.at === top) && ends.some(line => line.at === bottom))
      added.push({ axis: "y", at: side, start: top, end: bottom });
  }
  return normalize([...lines, ...added]);
}

/** 경계가 없는 인접 영역을 연결하고 외곽이 닫힌 직사각형만 셀로 반환합니다. */
function componentCells(source: Segment[]): Rect[] {
  const lines = closeOpenSides(source);
  const xs = coordinates(lines.flatMap(line => line.axis === "y" ? [line.at] : [line.start, line.end]));
  const ys = coordinates(lines.flatMap(line => line.axis === "x" ? [line.at] : [line.start, line.end]));
  const columns = xs.length - 1, rows = ys.length - 1;
  if (columns < 1 || rows < 1 || columns * rows > MAX_GRID_TILES) return [];
  /** 작은 구획의 한 변을 덮는 경계가 있는지 확인합니다. */
  const covered = (axis: Segment["axis"], at: number, start: number, end: number) =>
    lines.some(line => line.axis === axis && line.at === at && line.start <= start && line.end >= end);
  const seen = new Set<number>(), cells: Rect[] = [];
  for (let first = 0; first < rows * columns; first++) {
    if (seen.has(first)) continue;
    const pending = [first]; seen.add(first);
    let left = columns, right = 0, top = rows, bottom = 0, open = false;
    for (let i = 0; i < pending.length; i++) {
      const tile = pending[i], x = tile % columns, y = Math.floor(tile / columns);
      left = Math.min(left, x); right = Math.max(right, x + 1);
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
      const edges: [number, number, boolean][] = [
        [x - 1, y, covered("y", xs[x], ys[y], ys[y + 1])],
        [x + 1, y, covered("y", xs[x + 1], ys[y], ys[y + 1])],
        [x, y - 1, covered("x", ys[y], xs[x], xs[x + 1])],
        [x, y + 1, covered("x", ys[y + 1], xs[x], xs[x + 1])]
      ];
      for (const [nx, ny, wall] of edges) {
        if (wall) continue;
        if (nx < 0 || nx >= columns || ny < 0 || ny >= rows) { open = true; continue; }
        const next = ny * columns + nx;
        if (!seen.has(next)) { seen.add(next); pending.push(next); }
      }
    }
    // 일부 경계가 끊긴 영역이나 L자 영역을 임의의 병합 셀로 만들지 않습니다.
    if (!open && pending.length === (right - left) * (bottom - top)) {
      const rect = { x: xs[left], y: ys[top], width: xs[right] - xs[left], height: ys[bottom] - ys[top] };
      if (rect.width > 8 && rect.height > 6) cells.push(rect);
    }
  }
  return cells;
}

/** 연결된 그리기 경계를 표별로 분리하고 행·열·병합 셀을 복원합니다. */
export function cellsFromSegments(source: Segment[]): Rect[] {
  if (source.length > MAX_TABLE_SEGMENTS) return [];
  const lines = normalize(source), remaining = new Set(lines.map((_, index) => index));
  const cells: Rect[] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!;
    const group = [lines[first]]; remaining.delete(first);
    for (let i = 0; i < group.length; i++) {
      for (const index of remaining) if (touches(group[i], lines[index])) {
        group.push(lines[index]); remaining.delete(index);
      }
    }
    cells.push(...componentCells(group));
    // 후속 셀 연결과 텍스트 배정의 비용도 기존 페이지별 한도 안에 유지합니다.
    if (cells.length > MAX_TABLE_CELLS) return [];
  }
  return cells;
}
