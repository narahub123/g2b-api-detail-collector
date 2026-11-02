import { cellsFromSegments, MAX_TABLE_SEGMENTS } from "./table-geometry";
import type { Segment } from "./table-geometry";

export type Rect = { x: number; y: number; width: number; height: number };
export type Matrix = readonly number[];

/** PDF 원점·회전·배율을 표시 좌표계로 변환합니다. */
export function point(matrix: Matrix, x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

/** 중첩된 PDF 그리기 상태의 변환 행렬을 결합합니다. */
export function multiply(a: Matrix, b: Matrix): number[] {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

/** 꼭짓점 집합에서 표시 영역의 경계를 계산합니다. */
export function bounds(points: [number, number][]): Rect {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** 배경 사각형과 개별 직선에서 셀 경계를 복원하며 클리핑·곡선·기울어진 도형은 제외합니다. */
export function pathRectangles(list: { fnArray: number[]; argsArray: (unknown[] | null)[] }, viewport: Matrix,
  ops: { save: number; restore: number; transform: number; constructPath: number; endPath?: number;
    paintFormXObjectBegin?: number; paintFormXObjectEnd?: number }): Rect[] {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [], segments: Segment[] = [];
  /** 실제로 칠해진 축 평행 경로만 사용해 글리프의 클리핑 경계를 셀로 오인하지 않습니다. */
  const append = (vertices: [number, number][], valid: boolean, closed: boolean) => {
    if (!valid || vertices.length < 2 || vertices.some(vertex => !vertex.every(Number.isFinite))) return;
    const edges = vertices.slice(1).map((vertex, i) => [vertices[i], vertex]);
    if (closed) {
      if (vertices.length !== 4) return;
      const rect = bounds(vertices);
      if (rect.width <= 8 || rect.height <= 6) return;
      edges.push([vertices[vertices.length - 1], vertices[0]]);
    }
    if (edges.some(([a, b]) => Math.abs(a[0] - b[0]) >= 0.5 && Math.abs(a[1] - b[1]) >= 0.5)) return;
    for (const [a, b] of edges) {
      const horizontal = Math.abs(a[1] - b[1]) < 0.5;
      const start = Math.min(a[horizontal ? 0 : 1], b[horizontal ? 0 : 1]);
      const end = Math.max(a[horizontal ? 0 : 1], b[horizontal ? 0 : 1]);
      if (end > start) segments.push({ axis: horizontal ? "x" : "y", at: a[horizontal ? 1 : 0], start, end });
    }
  };
  for (let index = 0; index < list.fnArray.length; index++) {
    // 과도하게 복잡한 페이지에서 일부 경계만 채택하지 않고 일반 좌표 정렬로 돌아갑니다.
    if (segments.length > MAX_TABLE_SEGMENTS) return [];
    const fn = list.fnArray[index], args = list.argsArray[index];
    if (fn === ops.save) stack.push(matrix);
    else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === ops.paintFormXObjectBegin) {
      stack.push(matrix);
      if (args?.[0]) matrix = multiply(matrix, args[0] as number[]);
    }
    else if (fn === ops.transform) matrix = multiply(matrix, args as number[]);
    else if (fn === ops.constructPath) {
      if (ops.endPath !== undefined && args?.[0] === ops.endPath) continue;
      // PDF.js 6의 DrawOPS 경로를 읽습니다. 버전은 lockfile에 고정합니다.
      const data = (args?.[1] as (ArrayLike<number> | null)[] | undefined)?.[0];
      if (!data) continue;
      let vertices: [number, number][] = [];
      let valid = true;
      for (let offset = 0; offset < data.length;) {
        const command = data[offset++];
        if (command === 0 || command === 1) {
          if (command === 0) { append(vertices, valid, false); vertices = []; valid = true; }
          vertices.push(point(multiply(viewport, matrix), data[offset++], data[offset++]));
        } else if (command === 4) {
          append(vertices, valid, true);
          vertices = [];
        } else { valid = false; offset += command === 2 ? 6 : command === 3 ? 4 : data.length; }
      }
      append(vertices, valid, false);
    }
  }
  return cellsFromSegments(segments);
}
