import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { expect, it } from "vitest";
import { claimScheduledRun, getAutomationSettings, updateAutomationSettings } from "./automation-store";
import { getIncrementalCheckpoint } from "./incremental-store";

const runtime = globalThis as typeof globalThis & { __g2bPgPool?: pg.Pool };

it.skipIf(!process.env.LIVE_DB_TEST || !process.env.DATABASE_URL)(
  "claims each due time once and resets its anchor on reactivation in an isolated DB schema", async () => {
    const schema = `g2b_test_${randomUUID().replaceAll("-", "")}`;
    const directUrl = new URL(process.env.DATABASE_URL!);
    directUrl.hostname = directUrl.hostname.replace("-pooler.", ".");
    const admin = new pg.Client({ connectionString: directUrl.toString() });
    const oldSchema = process.env.G2B_DB_SCHEMA;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const ddl = await readFile(join(process.cwd(), "db", "schema.sql"), "utf8");
      await admin.query(ddl.replaceAll("public.", `${schema}.`));
      process.env.G2B_DB_SCHEMA = schema;
      runtime.__g2bPgPool = new pg.Pool({ connectionString: directUrl.toString(), max: 2 });
      expect((await getAutomationSettings()).enabled).toBe(false);
      const first = await updateAutomationSettings({ enabled: true, schedule: "interval", intervalMinutes: 60,
        times: [], startAt: "2026-10-27T09:00" }, new Date("2026-10-27T01:07:00.000Z"));
      expect(first.startAt).toBe("2026-10-27T00:00:00.000Z");
      const due = await claimScheduledRun(new Date("2026-10-27T02:08:00.000Z"));
      expect(due).toMatchObject({ kind: "due", dueAt: "2026-10-27T02:07:00.000Z" });
      expect(await claimScheduledRun(new Date("2026-10-27T02:08:00.000Z"))).toEqual({ kind: "not_due" });
      await updateAutomationSettings({ enabled: false, schedule: "interval", intervalMinutes: 60, times: [] },
        new Date("2026-10-27T03:00:00.000Z"));
      expect(await claimScheduledRun(new Date("2026-10-27T03:08:00.000Z"))).toEqual({ kind: "disabled" });
      await admin.query(`INSERT INTO ${schema}.collection_jobs(id,state,status,started_at)
        VALUES($1::uuid,$2::jsonb,'completed',$3::timestamptz)`, [randomUUID(), JSON.stringify({
        mode: "incremental", activationId: first.activationId, windowEnd: "2026-10-27T02:00:00.000Z"
      }), "2026-10-27T01:00:00.000Z"]);
      expect(await getIncrementalCheckpoint(first.activationId!)).toBe("2026-10-27T02:00:00.000Z");
      const next = await updateAutomationSettings({ enabled: true, schedule: "times", intervalMinutes: 60,
        times: ["09:10", "18:30"], startAt: "2026-10-27T10:00" }, new Date("2026-10-27T03:00:00.000Z"));
      expect(next.activationId).not.toBe(first.activationId);
      expect(next.lastDueAt).toBeNull();
      expect(await getIncrementalCheckpoint(next.activationId!)).toBeNull();
      expect(await claimScheduledRun(new Date("2026-10-27T09:31:00.000Z"))).toMatchObject({
        kind: "due", dueAt: "2026-10-27T09:30:00.000Z" });
    } finally {
      if (oldSchema === undefined) delete process.env.G2B_DB_SCHEMA; else process.env.G2B_DB_SCHEMA = oldSchema;
      if (runtime.__g2bPgPool) await runtime.__g2bPgPool.end();
      delete runtime.__g2bPgPool;
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }, 60_000);
