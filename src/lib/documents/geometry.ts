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

/** 닫힌 사각형 경로만 셀 후보로 사용하고 밑줄·곡선·기울어진 도형은 제외합니다. */
export function pathRectangles(list: { fnArray: number[]; argsArray: unknown[][] }, viewport: Matrix,
  ops: { save: number; restore: number; transform: number; constructPath: number; paintFormXObjectBegin?: number; paintFormXObjectEnd?: number }): Rect[] {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [], rectangles: Rect[] = [];
  for (let index = 0; index < list.fnArray.length && rectangles.length < 1500; index++) {
    const fn = list.fnArray[index], args = list.argsArray[index];
    if (fn === ops.save) stack.push(matrix);
    else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === ops.paintFormXObjectBegin) {
      stack.push(matrix);
      if (args?.[0]) matrix = multiply(matrix, args[0] as number[]);
    }
    else if (fn === ops.transform) matrix = multiply(matrix, args as number[]);
    else if (fn === ops.constructPath) {
      // PDF.js 6의 DrawOPS 경로를 읽습니다. 버전은 lockfile에 고정합니다.
      const data = (args?.[1] as (ArrayLike<number> | null)[] | undefined)?.[0];
      if (!data) continue;
      let vertices: [number, number][] = [];
      let valid = true;
      for (let offset = 0; offset < data.length;) {
        const command = data[offset++];
        if (command === 0 || command === 1) {
          if (command === 0) { vertices = []; valid = true; }
          vertices.push(point(multiply(viewport, matrix), data[offset++], data[offset++]));
        } else if (command === 4) {
          if (valid && vertices.length === 4 && vertices.every((p, i) => {
            const next = vertices[(i + 1) % 4];
            return Math.abs(p[0] - next[0]) < 0.5 || Math.abs(p[1] - next[1]) < 0.5;
          })) {
            const rect = bounds(vertices);
            if (rect.width > 8 && rect.height > 6 && Object.values(rect).every(Number.isFinite)) rectangles.push(rect);
          }
          vertices = [];
        } else { valid = false; offset += command === 2 ? 6 : command === 3 ? 4 : data.length; }
      }
    }
  }
  // 같은 셀의 배경·클리핑·테두리가 중복되어도 하나의 영역으로 취급합니다.
  return rectangles.filter((rect, i) => !rectangles.slice(0, i).some(other =>
    Math.abs(rect.x - other.x) < 1 && Math.abs(rect.y - other.y) < 1 &&
    Math.abs(rect.width - other.width) < 1 && Math.abs(rect.height - other.height) < 1));
}
