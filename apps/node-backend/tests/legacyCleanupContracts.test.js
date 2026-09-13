import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

describe("legacy cleanup contracts", () => {
  it("requires a verified backup and exact account parity before dropping bank labels", () => {
    const sql = read("alembic/manual/contract_drop_bank_account/up.sql");
    const testHarness = read("scripts/with-test-db.sh");
    expect(sql).toContain("backup_verified must equal yes");
    expect(sql).toContain("divergent bank_account/account_id identity");
    expect(sql).toContain("ACCESS EXCLUSIVE");
    expect(testHarness).toMatch(
      /-v backup_verified=yes\s+\\\s+-f alembic\/manual\/contract_drop_bank_account\/up\.sql/,
    );
  });

  it("archives and verifies every ADR-109 source row before CASCADE", () => {
    const sql = read("alembic/manual/drop_adr109_legacy_relations/up.sql");
    expect(sql).toContain("adr109_legacy_archive");
    expect(sql).toContain("archive count mismatch");
    expect(sql).toContain("archive digest mismatch");
    expect(sql).not.toContain("soak_verified");
    expect(sql).toContain("canonical_parity_verified must equal yes");
    expect(sql).toContain(
      "LOCK TABLE public.investments, public.portfolio_transactions",
    );
    expect(sql.indexOf("adr109_legacy_cleanup_marker")).toBeLessThan(
      sql.indexOf("RAISE NOTICE 'ADR-109 cleanup: no legacy residue found"),
    );
    expect(sql.indexOf("adr109_legacy_archive")).toBeLessThan(
      sql.indexOf("DROP VIEW"),
    );
  });

  it("requires ADR-109 retirement and zero dependencies before dropping the enum", () => {
    const sql = read("alembic/manual/drop_obsolete_recurrence_enum/up.sql");
    expect(sql).toContain("adr109_legacy_cleanup_marker");
    expect(sql).toContain("pg_depend");
    expect(sql).toContain("dependent_count <> 0");
    expect(sql).toContain("SELECT typarray FROM pg_type WHERE oid = enum_oid");
    expect(sql).toContain("backup_verified must equal yes");
    expect(sql).not.toContain("CASCADE");
  });

  it("guards tx_hash contraction with a backup and no unfinished legacy-hash batches", () => {
    const sql = read("alembic/manual/contract_drop_tx_hash/up.sql");
    expect(sql).toContain("backup_verified");
    expect(sql).not.toContain("fallback_free_verified");
    expect(sql).toContain("batch.status NOT IN");
    expect(sql).toContain("unfinished import batch still contains tx_hash");
    expect(sql).toContain("ACCESS EXCLUSIVE");
  });

  it("keeps active import SQL independent of the legacy tx_hash columns", () => {
    const runtimeFiles = [
      "apps/node-backend/src/repositories/transactionRepository.js",
      "apps/node-backend/src/services/importPipeline/validate.js",
      "apps/node-backend/src/services/importPipeline/commit.js",
      "apps/node-backend/src/services/portfolioImportPipeline/validate.js",
      "apps/node-backend/src/services/portfolioImportPipeline/commit.js",
    ];
    for (const path of runtimeFiles) {
      expect(read(path), path).not.toContain("tx_hash");
    }
  });

  it("proves statement scalar parity and has a collection-backed down path", () => {
    const up = read("alembic/manual/contract_drop_statement_scalars/up.sql");
    const down = read(
      "alembic/manual/contract_drop_statement_scalars/down.sql",
    );
    expect(up).toContain("IS DISTINCT FROM a.statement_balance");
    expect(up).toContain("backup_verified must equal yes");
    expect(up).toContain("only one account statement scalar column exists");
    expect(up).toContain("already applied; no columns to drop");
    expect(up).toContain("DROP COLUMN IF EXISTS statement_balance");
    expect(down).toContain("FROM account_statement_balances");
  });

  it("requires exact neutral raw payload and link parity before drops", () => {
    const sql = read("alembic/manual/contract_drop_provider_raw/up.sql");
    expect(sql).toContain("native_payload IS DISTINCT FROM to_jsonb(old)");
    expect(sql).toContain("raw-reference count mismatch");
    expect(sql).toContain("raw-reference identities or statuses differ");
    expect(sql).toContain("active manual identities lack neutral claims");
    expect(sql).toContain("backup_verified must equal yes");
    expect(sql.indexOf("payloads differ")).toBeLessThan(
      sql.indexOf("DROP TABLE IF EXISTS transaction_raw_references"),
    );
  });

  it("drops dormant bank resolution without blocking resumable batches", () => {
    const migration = read(
      "alembic/versions/0104_drop_dormant_import_bank_resolution.py",
    );
    const lifecycle = read("scripts/test-legacy-retirements.js");
    expect(migration).toContain("WHERE resolved_bank_account_id IS NOT NULL");
    expect(migration).not.toContain("batch.status NOT IN");
    expect(migration).not.toContain("active_batches");
    expect(lifecycle).toContain(
      "Upgrade did not preserve the non-terminal import batch",
    );
  });

  it("keeps the live retirement status command read-only and secret-free", () => {
    const script = read(
      "apps/node-backend/scripts/legacy-retirement-status.js",
    );
    expect(script).toContain('client.query("BEGIN READ ONLY")');
    expect(script).toContain('client.query("ROLLBACK")');
    expect(script).toContain("format('public.%I', $1::text)");
    expect(script).not.toContain("console.log(connectionString)");
    expect(script).not.toContain("query_start");
    expect(script).not.toContain("pg_stat_activity.query");
    expect(script).toContain("fingerprintedRows");
    expect(script).toContain("terminalBatchRows");
    expect(script).toContain("nonTerminalBatches");
    expect(script).toContain("elapsedTimeSoak");
  });
});
