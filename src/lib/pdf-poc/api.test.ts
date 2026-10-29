import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPdfPoc, readPdfPoc } from "./api";
import { getRun, listRuns, loadPdfAttachment } from "./store";
vi.mock("./store", () => ({ getRun: vi.fn(), listRuns: vi.fn(), loadPdfAttachment: vi.fn() }));
const id = "12345678-1234-1234-1234-123456789012";
const key = "R26BK01787632--000";

/** 관리자 로컬 요청에서 실제로 보내는 식별자만 구성합니다. */
function request() { return new Request("http://localhost:3000/api/admin/pdf-poc", { method: "POST", headers: { origin: "http://localhost:3000" }, body: JSON.stringify({ key, fileNo: "file", seq: 2 }) }); }

describe("PDF PoC API", () => {
  beforeEach(() => {
    vi.stubEnv("PDF_POC_ENABLED", "true"); vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("PDF_POC_WORKER_TOKEN", "a".repeat(32));
    vi.mocked(loadPdfAttachment).mockResolvedValue({ key, fileNo: "file", seq: 2, name: "공고.pdf", url: "saved" });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
  it("처리를 기다리지 않고 실행 ID만 반환합니다", async () => {
    const fetcher = vi.fn(async () => Response.json({ id }, { status: 202 })); vi.stubGlobal("fetch", fetcher);
    const response = await startPdfPoc(request());
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ id });
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ body: JSON.stringify({ key, fileNo: "file", seq: 2 }) }));
  });
  it("중복 실행·Docker 미실행·DB 오류를 구분하며 내부 오류는 노출하지 않습니다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 409 })));
    expect((await startPdfPoc(request())).status).toBe(409);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private token"); }));
    expect(await (await startPdfPoc(request())).text()).not.toContain("private token");
    vi.mocked(loadPdfAttachment).mockRejectedValueOnce(new Error("postgres://secret"));
    expect(await (await startPdfPoc(request())).text()).not.toContain("postgres://");
  });
  it("비활성화 시 DB에 접근하지 않습니다", async () => {
    vi.stubEnv("PDF_POC_ENABLED", "false"); expect((await startPdfPoc(request())).status).toBe(404);
    expect(loadPdfAttachment).not.toHaveBeenCalled();
  });
  it("상태·본문은 공고 키를 포함해 DB에서 읽고 다른 공고의 실행은 반환하지 않습니다", async () => {
    vi.mocked(getRun).mockResolvedValue(null);
    expect((await readPdfPoc(new Request(`http://localhost:3000/api/admin/pdf-poc/${id}?key=${key}`), id)).status).toBe(404);
    expect(getRun).toHaveBeenCalledWith(id, key);
    vi.mocked(listRuns).mockResolvedValue([{ id }]);
    expect(await (await readPdfPoc(new Request(`http://localhost:3000/api/admin/pdf-poc?key=${key}`))).json()).toEqual([{ id }]);
  });
});
