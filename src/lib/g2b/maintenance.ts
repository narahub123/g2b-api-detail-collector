import { load } from "cheerio";

export type MaintenanceInfo = {
  code: "g2b_maintenance";
  source: "api" | "detail" | "download";
  detectedAt: string;
  message: string;
};

const message = "나라장터 시스템 점검으로 보류했습니다. 현재 웹서비스가 중단되어 다음 실행에서 다시 확인합니다.";

/** 일반 오류와 구분되는 점검 근거를 실행 경계까지 전달합니다. */
export class G2bMaintenanceError extends Error {
  readonly maintenance: MaintenanceInfo;
  constructor(source: MaintenanceInfo["source"], detectedAt = new Date().toISOString()) {
    super(message);
    this.name = "G2bMaintenanceError";
    this.maintenance = { code: "g2b_maintenance", source, detectedAt, message };
  }
}

/** 공지의 단순 언급을 제외하고 현재 서비스 중단 안내가 있는 점검 화면만 판별합니다. */
export function assertNotMaintenance(html: string, source: MaintenanceInfo["source"]): void {
  if (!/<(?:html|title|h[12])(?:\s|>)/i.test(html)) return;
  const $ = load(html);
  const heading = $("title,h1,h2").toArray().some(element => $(element).text().replace(/\s/g, "") === "시스템점검안내");
  if (heading && $.text().replace(/\s/g, "").includes("현재웹서비스가중단되고있음을알려드립니다"))
    throw new G2bMaintenanceError(source);
}

/** 프로세스에서 받은 점검 정보도 허용된 값만 복원하고 임의 안내문은 저장하지 않습니다. */
export function restoreMaintenance(value: unknown): G2bMaintenanceError | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<MaintenanceInfo>;
  if (data.code !== "g2b_maintenance" || !["api", "detail", "download"].includes(data.source ?? "") ||
    typeof data.detectedAt !== "string" || !Number.isFinite(Date.parse(data.detectedAt))) return null;
  return new G2bMaintenanceError(data.source!, new Date(data.detectedAt).toISOString());
}

/** API 페이지 오류처럼 원인이 감싸져 있어도 점검 신호를 잃지 않습니다. */
export function maintenanceFromError(error: unknown): MaintenanceInfo | null {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof G2bMaintenanceError) return error.maintenance;
    seen.add(error);
    error = error.cause;
  }
  return null;
}

/** 완료 기준점을 유지하고 진행 중 공고를 실패로 바꾸지 않은 채 보류를 기록합니다. */
export function deferCollection(job: import("./collection-job").CollectionJob, error: unknown): boolean {
  const maintenance = maintenanceFromError(error);
  if (!maintenance) return false;
  job.status = "deferred";
  job.maintenance = maintenance;
  for (const result of job.results ?? []) {
    if (result.startedAt && !result.finishedAt) {
      result.error = maintenance.message;
      result.finishedAt = maintenance.detectedAt;
    }
  }
  return true;
}
