import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { applyDocumentMigration } from "./migration";

it.skipIf(!process.env.LIVE_DB_TEST || !process.env.DATABASE_URL)("PoC 이관은 UUID·본문·통계·마지막 성공을 보존하고 재실행·오류·잠금을 안전하게 처리합니다", async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname.endsWith(".neon.tech")) url.hostname = url.hostname.replace("-pooler.", ".");
  const db = new pg.Client({ connectionString: url.toString() });
  const schema = `doc_migration_test_${randomUUID().replaceAll("-", "")}`;
  const key = "R26BK01797756--001", otherKey = "R26BK01787632--000";
  const fileNo = "b8b7060e-2517-42c4-8766-b7eb79bcb8a1", secondFileNo = "8d099a9b-22c2-4b70-9ef7-23ed5d48d208";
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const attachment = (notice: string, file: string, seq: number) => `/api/attachments/${notice}?fileNo=${file}&seq=${seq}`;
  try {
    await db.connect(); await db.query("BEGIN"); await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`CREATE TABLE ${schema}.notices(key text PRIMARY KEY,detail jsonb)`);
    const oldDdl = await readFile("db/migrations/0005-pdf-extraction-poc.sql", "utf8");
    await db.query(oldDdl.replaceAll("public.", `${schema}.`));
    await db.query(`INSERT INTO ${schema}.notices VALUES($1,$2),($3,$4)`, [key, { attachments: [
      { name: "공고.pdf", url: attachment(key, fileNo, 1) }, { name: "공고.pdf", url: attachment(key, secondFileNo, 1) }
    ] }, otherKey, { attachments: [{ name: "공고.pdf", url: attachment(otherKey, fileNo, 1) }] }]);
    const cases = [
      { id: ids[0], key, file: fileNo, seq: 1, status: "completed", version: "6.4.299", pages: [{ pageNumber: 1, text: "이전 본문" }] },
      { id: ids[1], key, file: fileNo, seq: 1, status: "completed", version: "6.4.299 / reading-order-v1", pages: [{ pageNumber: 1, text: "참가 자격" }, { pageNumber: 2, text: "기한" }] },
      { id: ids[2], key, file: fileNo, seq: 1, status: "failed", version: null, pages: [] },
      { id: ids[3], key, file: secondFileNo, seq: 1, status: "processing", version: null, pages: [] },
      { id: ids[4], key, file: fileNo, seq: 2, status: "completed", version: "6.4.299", pages: [{ pageNumber: 1, text: "삭제된 첨부 이력" }] },
      { id: ids[5], key: otherKey, file: fileNo, seq: 1, status: "completed", version: "6.4.299", pages: [{ pageNumber: 1, text: "다른 공고" }] }
    ];
    for (const [index, row] of cases.entries()) {
      await db.query(`INSERT INTO ${schema}.pdf_extraction_poc_runs
        (id,notice_key,file_no,seq,filename,attachment_url,status,pages,page_count,character_count,extractor_version,
          file_hash,peak_memory_bytes,started_at,finished_at,elapsed_ms,error)
        VALUES($1,$2,$3,$4,'공고.pdf',$5,$6,$7,$8,$9,$10,$11,1024,$12,$13,$14,$15)`,
      [row.id, row.key, row.file, row.seq, attachment(row.key, row.file, row.seq), row.status, JSON.stringify(row.pages),
        row.status === "completed" ? row.pages.length : null, row.status === "completed" ? row.pages.reduce((s, p) => s + p.text.length, 0) : null,
        row.version, row.status === "completed" ? "test-hash" : null, `2026-10-29T00:0${index}:00Z`,
        row.status === "processing" ? null : `2026-10-29T00:0${index}:01Z`, row.status === "processing" ? null : 1000,
        row.status === "failed" ? "다운로드 실패" : null]);
    }
    const before = (await db.query(`SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) hash FROM ${schema}.pdf_extraction_poc_runs p`)).rows[0].hash;
    const report = await applyDocumentMigration(db, schema);
    expect(report).toMatchObject({ sourceRuns: 6, importedRuns: 6, newlyImportedRuns: 6, documents: 4, archivedDocuments: 1, sourcePages: 5, importedPages: 5 });
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    const documents = (await db.query(`SELECT * FROM ${schema}.attachment_documents ORDER BY notice_key,file_no,seq`)).rows;
    const document = documents.find(row => row.notice_key === key && row.file_no === fileNo && row.seq === 1);
    expect(document.last_success_run_id).toBe(ids[1]); expect(document.latest_run_id).toBe(ids[2]);
    expect(documents.find(row => row.seq === 2).is_current).toBe(false);
    const migrated = (await db.query(`SELECT * FROM ${schema}.attachment_extraction_runs WHERE id=$1`, [ids[3]])).rows[0];
    expect(migrated.status).toBe("interrupted"); expect(migrated.retry_eligible).toBe(false);
    expect((await db.query(`SELECT status FROM ${schema}.pdf_extraction_poc_runs WHERE id=$1`, [ids[3]])).rows[0].status).toBe("processing");
    expect(await applyDocumentMigration(db, schema)).toMatchObject({ newlyImportedRuns: 0, importedRuns: 6 });
    expect((await db.query(`SELECT * FROM ${schema}.attachment_documents ORDER BY notice_key,file_no,seq`)).rows).toEqual(documents);

    // 운영에서 생긴 성공 포인터를 재이관이 과거 PoC 결과로 되돌리면 안 됩니다.
    const operational = randomUUID();
    await db.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url,pages)
      VALUES($1,$2,$1,'manual','completed','공고.pdf',$3,'[]')`, [operational, document.id, attachment(key, fileNo, 1)]);
    await db.query(`UPDATE ${schema}.attachment_documents SET last_success_run_id=$1,latest_run_id=$1,active_chain_id=$1 WHERE id=$2`, [operational, document.id]);
    await applyDocumentMigration(db, schema);
    expect((await db.query(`SELECT last_success_run_id FROM ${schema}.attachment_documents WHERE id=$1`, [document.id])).rows[0].last_success_run_id).toBe(operational);

    // 무결성 불일치는 덮어쓰지 않고 이관을 중단해야 합니다.
    await db.query("SAVEPOINT corrupted");
    await db.query(`UPDATE ${schema}.attachment_extraction_runs SET pages='[]' WHERE id=$1`, [ids[1]]);
    await expect(applyDocumentMigration(db, schema)).rejects.toThrow("무결성");
    await db.query("ROLLBACK TO SAVEPOINT corrupted");

    // 다른 문서 결과 참조, 활성 요청 중복과 3회를 넘는 시도를 DB에서도 거부합니다.
    await db.query("SAVEPOINT wrong_pointer");
    await expect(db.query(`UPDATE ${schema}.attachment_documents SET last_success_run_id=$1 WHERE id=$2`, [ids[5], document.id])).rejects.toThrow();
    await db.query("ROLLBACK TO SAVEPOINT wrong_pointer");
    await db.query("SAVEPOINT duplicate_queue");
    const queued = randomUUID(), duplicate = randomUUID();
    await db.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url)
      VALUES($1,$2,$1,'manual','queued','공고.pdf',$3)`, [queued, document.id, attachment(key, fileNo, 1)]);
    await expect(db.query(`INSERT INTO ${schema}.attachment_extraction_runs(id,document_id,chain_id,source,status,filename,attachment_url)
      VALUES($1,$2,$1,'manual','queued','공고.pdf',$3)`, [duplicate, document.id, attachment(key, fileNo, 1)])).rejects.toThrow();
    await db.query("ROLLBACK TO SAVEPOINT duplicate_queue");
    await db.query("SAVEPOINT bad_attempt");
    await expect(db.query(`UPDATE ${schema}.attachment_extraction_runs SET attempt_number=4 WHERE id=$1`, [operational])).rejects.toThrow();
    await db.query("ROLLBACK TO SAVEPOINT bad_attempt");
    const after = (await db.query(`SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) hash FROM ${schema}.pdf_extraction_poc_runs p`)).rows[0].hash;
    expect(after).toBe(before);
  } finally {
    // 이 테스트가 생성한 자료와 스키마는 커밋하지 않고 모두 롤백합니다.
    await db.query("ROLLBACK").catch(() => undefined); await db.end();
  }
}, 60_000);

it.skipIf(!process.env.LIVE_DB_TEST || !process.env.DATABASE_URL)("PoC 서비스 잠금이 있으면 이관을 거부합니다", async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname.endsWith(".neon.tech")) url.hostname = url.hostname.replace("-pooler.", ".");
  const db = new pg.Client({ connectionString: url.toString() }), owner = new pg.Client({ connectionString: url.toString() });
  const schema = `doc_lock_test_${randomUUID().replaceAll("-", "")}`;
  const lockKey = `g2b-pdf-poc:${schema}.pdf_extraction_poc_runs`;
  try {
    await db.connect(); await owner.connect(); await db.query("BEGIN");
    await owner.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lockKey]);
    await expect(applyDocumentMigration(db, schema)).rejects.toThrow("PoC");
    expect((await db.query("SELECT to_regclass($1) name", [`${schema}.attachment_documents`])).rows[0].name).toBeNull();
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await owner.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]).catch(() => undefined);
    await Promise.all([db.end(), owner.end()]);
  }
}, 30_000);
