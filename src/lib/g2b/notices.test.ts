import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listNotices, getNotice, getNoticeRecord } from "./notices";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("saved notices", () => {
  it("resolves a generic numbered detail and an already stored notice reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-notices-")); dirs.push(dir);
    await mkdir(join(dir, "notices"));
    await mkdir(join(dir, "independent-details"));
    await writeFile(join(dir, "notices", "R26BK01774553--000.json"), JSON.stringify({
      key: "R26BK01774553--000", api: null, detail: { sourceUrl: "source", attachments: [], links: [] },
      otherDetailNumbers: ["R26TA12345678", "R26BK12345678-000"],
      independentTriggers: [{ number: "R26BK12345678-000",
        trigger: { index: 1, tag: "a", label: "다른 공고", value: "R26BK12345678-000", html: "<a>조회</a>" } }]
    }));
    await writeFile(join(dir, "independent-details", "R26TA12345678.json"), JSON.stringify({
      schemaVersion: 2, number: "R26TA12345678", title: "계약 상세", fields: [{ label: "계약", value: [{ text: "완료", visible: true }] }],
      tables: [], capturedAt: "2026-10-19T00:00:00Z", sourceNoticeKey: "R26BK01774553--000"
    }));
    await writeFile(join(dir, "notices", "R26BK12345678--000.json"), JSON.stringify({
      key: "R26BK12345678--000", api: null, detail: { sourceUrl: "existing", attachments: [], links: [] }
    }));
    const record = await getNoticeRecord("R26BK01774553--000", dir);
    expect(record?.otherDetails[0].detail?.fields?.[0].value).toEqual([{ text: "완료", visible: true }]);
    expect(record?.otherDetails[1].noticeKey).toBe("R26BK12345678--000");
    expect(record?.otherDetails[1].triggers?.[0].label).toBe("다른 공고");
  });
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
      detail: { sourceUrl: "https://www.g2b.go.kr/", sections: [{ title: "입찰자격", fields: [
        { label: "업종제한사항", value: [{ text: "연구", visible: true }] }
      ], tables: [{ columns: ["구분"], rows: [["이전 형식"]] }] }], text: "전체 본문", attachments: [], links: [] }
    }));
    const record = await getNoticeRecord("R26BK1--000", dir);
    expect(record?.api?.srvceDivNm).toBe("연구");
    expect(record?.detail?.text).toBe("전체 본문");
    expect(record?.detail?.sections?.[0].tables[0]).toEqual({ columns: ["구분"], rows: [["이전 형식"]] });
    expect(record?.normalized.title.value).toBe("용역");
    expect(await getNoticeRecord("../bad", dir)).toBeNull();
  });

  it("loads API-free related notices and unique direct relationships", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-notices-")); dirs.push(dir);
    await mkdir(join(dir, "notices"));
    await writeFile(join(dir, "notices", "R26BK1--001.json"), JSON.stringify({
      key: "R26BK1--001", api: null,
      detail: { sourceUrl: "https://www.g2b.go.kr/", sections: [{ title: "공고일반", fields: [
        { label: "공고명", value: [{ text: "이전 공고", visible: true }] }
      ], tables: [] }], text: "본문", attachments: [], links: [] },
      relatedNoticeKeys: ["R26BK1--002", "R26BK1--002"]
    }));
    const record = await getNoticeRecord("R26BK1--001", dir);
    expect(record?.api).toBeNull();
    expect(record?.normalized.title.value).toBe("이전 공고");
    expect(record?.relatedNoticeKeys).toEqual(["R26BK1--002"]);
    await writeFile(join(dir, "notices", "R26BK1--002.json"), JSON.stringify({
      key: "wrong--key", api: null, detail: null
    }));
    expect(await getNoticeRecord("R26BK1--002", dir)).toBeNull();
  });

  it("resolves independent references and reports a missing referenced file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "g2b-notices-")); dirs.push(dir);
    await mkdir(join(dir, "notices"));
    await mkdir(join(dir, "order-plans"));
    await writeFile(join(dir, "notices", "R26BK1--000.json"), JSON.stringify({
      key: "R26BK1--000", api: { bidNtceNo: "R26BK1", bidNtceOrd: "000" }, detail: null,
      orderPlanNumbers: ["R26DD1"], preSpecificationNumbers: ["R26BD1"]
    }));
    await writeFile(join(dir, "order-plans", "R26DD1.json"), JSON.stringify({
      schemaVersion: 2, number: "R26DD1", title: "발주계획상세조회", fields: [], tables: [],
      capturedAt: "2026-10-19T00:00:00Z", sourceNoticeKey: "R26BK1--000"
    }));
    const record = await getNoticeRecord("R26BK1--000", dir);
    expect(record?.orderPlans[0].detail?.number).toBe("R26DD1");
    expect(record?.preSpecifications).toEqual([{ number: "R26BD1", detail: null }]);
  });
});
