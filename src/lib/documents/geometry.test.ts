import { describe, expect, it } from "vitest";
import { pathRectangles } from "./geometry";

const ops = { save: 10, restore: 11, transform: 12, constructPath: 91, endPath: 28 };
const identity = [1, 0, 0, 1, 0, 0];

/** PDF.js의 축에 평행한 독립 선 그리기 명령을 구성합니다. */
function drawing(segments: number[][]) {
  return { fnArray: segments.map(() => ops.constructPath),
    argsArray: segments.map(([x1, y1, x2, y2]) => [20, [[0, x1, y1, 1, x2, y2]], null]) };
}

describe("개별 선의 표 셀 복원", () => {
  it.each([false, true])("오른쪽 외곽선 생략=%s인 표를 복원하고 병합 셀을 유지합니다", open => {
    const segments = [[0, 0, 200, 0], [0, 30, 200, 30], [0, 60, 200, 60],
      [60, 15, 200, 15], [0, 0, 0, 60], [60, 0, 60, 60]];
    if (!open) segments.push([200, 0, 200, 60]);
    const result = pathRectangles(drawing(segments), identity, ops);
    expect(result).toEqual(expect.arrayContaining([
      { x: 0, y: 0, width: 60, height: 30 }, { x: 60, y: 0, width: 140, height: 15 },
      { x: 60, y: 15, width: 140, height: 15 }, { x: 0, y: 30, width: 60, height: 30 },
      { x: 60, y: 30, width: 140, height: 30 }
    ]));
    expect(result).toHaveLength(5);
  });

  it("선 조각과 중복 경계를 합치고 작은 끝점 오차를 허용합니다", () => {
    const result = pathRectangles(drawing([[0, 0, 100, 0], [100.3, 0.2, 200, 0.2],
      [0, 30, 200, 30], [0, 60, 200, 60], [0, 0, 0, 60], [60, 0, 60, 60],
      [200, 0, 200, 60], [60.2, 0, 60.2, 60]]), identity, ops);
    expect(result).toHaveLength(4);
  });

  it("밑줄·장식선·클리핑 경로로 셀을 만들지 않습니다", () => {
    const list = drawing([[0, 0, 200, 0], [0, 30, 200, 30], [10, 40, 40, 50]]);
    list.fnArray.push(91);
    list.argsArray.push([28, [[0, 0, 0, 1, 200, 0, 1, 200, 60, 1, 0, 60, 4]], null]);
    expect(pathRectangles(list, identity, ops)).toEqual([]);
  });

  it("다중 경로와 회전·배율·이동을 거친 직선 표도 표시 좌표로 복원합니다", () => {
    const list = drawing([[0, 0, 200, 0], [0, 30, 200, 30], [0, 60, 200, 60],
      [0, 0, 0, 60], [60, 0, 60, 60], [200, 0, 200, 60]]);
    const joined = list.argsArray.flatMap(args => (args[1] as number[][])[0]);
    const result = pathRectangles({ fnArray: [10, 12, 91, 11],
      argsArray: [[], [0, 2, -2, 0, 300, 20], [20, [joined], null], []] }, identity, ops);
    expect(result).toHaveLength(4);
    expect(result).toContainEqual({ x: 180, y: 20, width: 60, height: 120 });
  });

  it("별도 표를 연결하지 않고 자원 한도를 넘으면 부분 결과를 버립니다", () => {
    const table = [[0, 0, 100, 0], [0, 30, 100, 30], [0, 60, 100, 60],
      [0, 0, 0, 60], [50, 0, 50, 60], [100, 0, 100, 60]];
    expect(pathRectangles(drawing([...table, ...table.map(line => line.map((n, i) => i % 2 ? n : n + 300))]), identity, ops)).toHaveLength(8);
    expect(pathRectangles(drawing(Array.from({ length: 6001 }, () => table[0])), identity, ops)).toEqual([]);
  });
  it("촘촘한 격자가 후속 표 정렬의 셀 한도를 넘으면 일반 좌표 정렬로 돌아갑니다", () => {
    const grid = Array.from({ length: 41 }, (_, i) => i * 10).flatMap(at => [
      [0, at, 400, at], [at, 0, at, 400]]);
    expect(pathRectangles(drawing(grid), identity, ops)).toEqual([]);
  });
});
