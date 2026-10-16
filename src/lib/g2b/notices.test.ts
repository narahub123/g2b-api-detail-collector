import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listNotices, getNotice, getNoticeRecord } from "./notices";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("saved notices", () => {
  it("lists separate orders and ignores broken JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-notices-")); dirs.push(dir);
    await mkdir(join(dir, "notices"));
    for (const order of ["000", "001"]) {
      await writeFile(join(dir, "notices", `R26BK1--${order}.json`), JSON.stringify({ api: { bidNtceNo: "R26BK1", bidNtceOrd: order, bidNtceNm: `용역 ${order}` }, detail: null }));
    }
    await writeFile(join(dir, "notices", "bad.json"), "invalid");
    const notices = await listNotices(dir);
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map((notice) => notice.order)).size).toBe(2);
    expect((await getNotice("R26BK1--001", dir))?.title.value).toBe("용역 001");
    expect(await getNotice("../bad", dir)).toBeNull();
  });

  it("rebuilds normalized fields from saved sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-notices-")); dirs.push(dir);
    await mkdir(join(dir, "notices"));
    await writeFile(join(dir, "notices", "R26BK1--000.json"), JSON.stringify({
      api: { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "용역" },
      detail: null, normalized: {}
    }));
    const notices = await listNotices(dir);
    expect(notices[0].title.value).toBe("용역");
  });

  it("loads the saved API item and scraped detail for comparison", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-notices-")); dirs.push(dir);
    await mkdir(join(dir, "notices"));
    await writeFile(join(dir, "notices", "R26BK1--000.json"), JSON.stringify({
      api: { bidNtceNo: "R26BK1", bidNtceOrd: "000", bidNtceNm: "용역", srvceDivNm: "연구" },
      detail: { sourceUrl: "https://www.g2b.go.kr/", fields: { "업종제한사항": "연구" }, text: "전체 본문", attachments: [], links: [] }
    }));
    const record = await getNoticeRecord("R26BK1--000", dir);
    expect(record?.api.srvceDivNm).toBe("연구");
    expect(record?.detail?.text).toBe("전체 본문");
    expect(record?.normalized.title.value).toBe("용역");
    expect(await getNoticeRecord("../bad", dir)).toBeNull();
  });
});
