import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchServiceNotices } from "./api-client";

it.skipIf(!process.env.LIVE_G2B)("reads a real posted-date API page", async () => {
  const environment = await readFile(join(process.cwd(), ".env.local"), "utf8");
  process.env.G2B_SERVICE_KEY = environment.match(/^G2B_SERVICE_KEY=(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, "");
  expect(process.env.G2B_SERVICE_KEY).toBeTruthy();
  const page = await fetchServiceNotices({ start: "2026-09-22", end: "2026-09-22" }).next();
  expect(page.done).toBe(false);
  expect(page.value?.items.length).toBeGreaterThan(0);
  expect(page.value?.items[0].bidNtceNo).toBeTruthy();
}, 45_000);
