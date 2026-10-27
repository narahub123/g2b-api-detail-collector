/**
 * User/admin list data query benchmark (both pages call listNoticePage).
 * Run from repository root with Node 24 + tsx:
 *   node --env-file=.env.local --import tsx scripts/benchmark-notice-list.mjs
 * No application source files are modified.
 */
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const intArg = (name, fallback) => {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > 10000) throw new Error(`--${name} must be an integer from 1 to 10000`);
  return n;
};
const iterations = intArg('iterations', 30);
const warmup = intArg('warmup', 5);
const page = intArg('page', 1);
const output = process.argv.find((arg) => arg.startsWith('--out='))?.slice(6)
  || `benchmarks/results/notice-list-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const params = new URLSearchParams();
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith('--filter.')) continue;
  const eq = arg.indexOf('=');
  if (eq === -1) throw new Error(`Missing value: ${arg}`);
  params.set(arg.slice('--filter.'.length, eq), arg.slice(eq + 1));
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Load .env.local using node --env-file=.env.local');

// Intercept only Pool.query, which is the read path used by listNoticePage.
// No double-counting of internal Client.query calls.
const originalQuery = pg.Pool.prototype.query;
let active = null;
pg.Pool.prototype.query = function (...args) {
  if (!active) return originalQuery.apply(this, args);
  const sample = active;
  sample.queryCount++;
  // Current list read path uses promise-returning Pool.query calls.
  const result = originalQuery.apply(this, args);
  if (!result || typeof result.then !== 'function') {
    throw new Error('Benchmark only supports promise-based Pool.query calls');
  }
  return result.then((value) => {
    // Approximate JS/JSON payload size, NOT actual PostgreSQL network bytes.
    sample.dbResultBytes += Buffer.byteLength(JSON.stringify(value.rows ?? []), 'utf8');
    return value;
  });
};

const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
const summarize = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return {
    mean: numbers.reduce((sum, n) => sum + n, 0) / numbers.length,
    p50: percentile(sorted, 0.50), p95: percentile(sorted, 0.95),
    min: sorted[0], max: sorted.at(-1),
  };
};
let pool;
try {
  const { listNoticePage } = await import('../../src/lib/g2b/notices.ts');
  const { parseNoticeFilters } = await import('../../src/lib/g2b/notice-filters.ts');
  const { getPool } = await import('../../src/lib/g2b/postgres-store.ts');
  const rawFilters = Object.fromEntries(params);
  const parsed = parseNoticeFilters(rawFilters);
  if (parsed.error) throw new Error(`Invalid filters: ${parsed.error}`);
  pool = getPool();
  const run = async () => {
    const sample = { queryCount: 0, dbResultBytes: 0 };
    active = sample;
    const start = performance.now();
    try {
      const result = await listNoticePage(parsed.filters, page);
      return {
        elapsedMs: performance.now() - start,
        ...sample,
        noticeCount: result.notices.length,
        totalCount: result.totalCount,
        resolvedPage: result.page,
        totalPages: result.totalPages,
      };
    } finally { active = null; }
  };
  console.log(`Warmup: ${warmup}; measured runs: ${iterations}; requested page: ${page}`);
  for (let i = 0; i < warmup; i++) await run();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    samples.push(await run());
    process.stdout.write(`\rMeasured ${i + 1}/${iterations}`);
  }
  process.stdout.write('\n');
  const counts = [...new Set(samples.map((s) => `${s.noticeCount}/${s.totalCount}/${s.resolvedPage}`))];
  if (counts.length !== 1) console.warn('WARNING: Notice counts/pages changed during benchmark:', counts);
  const stats = {
    elapsedMs: summarize(samples.map((s) => s.elapsedMs)),
    queryCount: summarize(samples.map((s) => s.queryCount)),
    dbResultBytes: summarize(samples.map((s) => s.dbResultBytes)),
    noticeCount: summarize(samples.map((s) => s.noticeCount)),
  };
  let gitCommit = null;
  let gitBranch = null;
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    gitBranch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  } catch { /* git metadata optional */ }
  const report = {
    benchmark: 'listNoticePage (shared by user / and admin /admin)',
    timestamp: new Date().toISOString(), gitBranch, gitCommit,
    nodeVersion: process.version, iterations, warmup, requestedPage: page,
    filters: parsed.filters,
    note: 'dbResultBytes is UTF-8 JSON.stringify(result.rows) size for Pool.query responses; not actual wire bytes. This measures data retrieval, not HTML rendering.',
    stats, samples,
  };
  const dest = resolve(output);
  await mkdir(resolve(dest, '..'), { recursive: true });
  await writeFile(dest, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(stats, null, 2));
  console.log(`Saved: ${dest}`);
} finally {
  active = null;
  pg.Pool.prototype.query = originalQuery;
  if (pool) await pool.end();
}
