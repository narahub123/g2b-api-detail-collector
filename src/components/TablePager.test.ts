import { expect, it } from "vitest";
import { tablePageRanges } from "./TablePager";

it("행 병합이 10행 경계를 넘으면 같은 페이지에 둔다", () => {
  const rows = Array.from({ length: 13 }, (_, index) => ({ index, cells: [{ value: String(index), column: 0,
    rowspan: index === 9 ? 3 : 1, colspan: 1 }] }));
  expect(tablePageRanges(rows)).toEqual([{ start: 0, end: 12 }, { start: 12, end: 13 }]);
});
