/**
 * Real-database pins for surviving migrations 0089 (TEXT + named CHECK for the
 * free-text enum columns) and 0090 (canonical chk_/uq_/idx_ names). Later
 * guarded contracts retired the raw-reference table, scalar balance, raw-bank
 * indexes and transaction hash index; they are not part of the current schema.
 *
 * What only a real database can verify here (SQLite since ADR-263):
 *   1. The surviving 0089 CHECKs exist under their pinned names. SQLite has no
 *      NOT VALID constraints: every CHECK holds for every row.
 *   2. CHECK behaviour at the SQL layer, bypassing app validators entirely:
 *      every value the app can legitimately write is accepted (all
 *      SUPPORTED_PATTERNS — imported from the real module so vocabulary drift
 *      fails here — the "every N days" grammar, both portfolio matcher
 *      sources and both brokerage routes) and
 *      out-of-vocabulary values are rejected with the pinned constraint name.
 *      Notably `'bi-weekly'` — the recurrence_interval PG-enum spelling — is
 *      REJECTED for planned_transactions.recurrence_pattern: 0089 settles that
 *      column on 'biweekly'.
 *   3. The surviving 0090 rename inventory: every new name present, every old name gone
 *      (constraints from the CREATE TABLE text, indexes from sqlite_schema),
 *      and the renamed unique indexes are still UNIQUE.
 *
 * Isolation: every data-touching case runs in a transaction that is always
 * rolled back; nothing this suite writes survives it.
 */

import { describe, expect, it } from "vitest";
import type { PgPoolClient } from "../src/database/connection.ts";
import { getTestPool, inRollbackTransaction } from "./setup/db.ts";
import { constraintNames, indexes, objectNames, objectSql, objectType, column } from "./helpers/sqliteCatalog.ts";
import { __getSupportedPatterns as getSupportedPatterns } from "../src/lib/calculations/recurrence.ts";
import { must } from "./helpers/must.ts";

/** A row from an ad-hoc SQL read: column values are narrowed where used. */
type DbRow = Record<string, unknown>;
interface IdRow {
  id: number;
}
/** BIGINT ids arrive as strings, as node-postgres returned them. */
interface BigIdRow {
  id: string;
}

const pool = getTestPool();

/** Surviving entries from _CHECKS in 0089; the raw-reference table was retired. */
const NEW_CHECKS = [
  ["planned_transactions", "chk_planned_transactions_recurrence_pattern"],
  [
    "portfolio_import_staging_rows",
    "chk_portfolio_import_staging_rows_match_source",
  ],
  ["portfolio_import_staging_rows", "chk_portfolio_import_staging_rows_route"],
];

/** Constraint renames from former migration 0090, now part of 0001_baseline. */
const CONSTRAINT_RENAMES = [
  [
    "accounts",
    "ck_accounts_active_not_closed",
    "chk_accounts_active_not_closed",
  ],
  [
    "custom_parser_configs",
    "ck_custom_parser_configs_kind",
    "chk_custom_parser_configs_kind",
  ],
  [
    "instrument_provider_map",
    "ck_instrument_provider_map_key_type",
    "chk_instrument_provider_map_key_type",
  ],
  [
    "instrument_provider_map",
    "ck_instrument_provider_map_status",
    "chk_instrument_provider_map_status",
  ],
  [
    "planned_transactions",
    "ck_planned_max_occurrences_positive",
    "chk_planned_max_occurrences_positive",
  ],
  [
    "provider_quota",
    "ck_provider_quota_count_nonneg",
    "chk_provider_quota_count_nonneg",
  ],
  [
    "transactions",
    "ck_transactions_transfer_source",
    "chk_transactions_transfer_source",
  ],
  [
    "transfer_dismissals",
    "ck_transfer_dismissals_ordered",
    "chk_transfer_dismissals_ordered",
  ],
  ["ai_messages", "ai_messages_role_check", "chk_ai_messages_role"],
  ["ai_messages", "ai_messages_status_check", "chk_ai_messages_status"],
  [
    "import_batches",
    "import_batches_status_check",
    "chk_import_batches_status",
  ],
  [
    "import_staging_rows",
    "import_staging_rows_status_check",
    "chk_import_staging_rows_status",
  ],
];

/** Index renames from former migration 0090, now part of 0001_baseline. */
const INDEX_RENAMES = [
  ["uniq_pte_planned_executed", "uq_pte_planned_executed", true],
  ["ux_transactions_opening_anchor", "uq_transactions_opening_anchor", true],
  [
    "ix_import_staging_rows_matched_pattern_id",
    "idx_import_staging_rows_matched_pattern_id",
    false,
  ],
  [
    "ix_import_staging_rows_user_override_recipient_id",
    "idx_import_staging_rows_user_override_recipient_id",
    false,
  ],
  [
    "ix_instrument_provider_map_provider_symbol",
    "idx_instrument_provider_map_provider_symbol",
    false,
  ],
  [
    "ix_portfolio_import_staging_rows_resolved_investment_id",
    "idx_portfolio_import_staging_rows_resolved_investment_id",
    false,
  ],
  [
    "ix_portfolio_import_staging_rows_user_override_investment_id",
    "idx_portfolio_import_staging_rows_user_override_investment_id",
    false,
  ],
  [
    "ix_snapshot_accounts_currency_date",
    "idx_snapshot_accounts_currency_date",
    false,
  ],
  ["ix_transfer_dismissals_b", "idx_transfer_dismissals_b", false],
];

/** The eight historical bank source types remain valid provenance values. */
const RAW_SOURCE_TYPES = [
  "belfius",
  "custom",
  "kbc",
  "manual",
  "revolut",
  "sabb",
  "vision",
  "wise",
];

/** Later category-hierarchy checks intentionally retain their 0114 names. */
const CATEGORY_CHECKS = [
  "ck_categories_hierarchy_only_not_legacy",
  "ck_categories_name_nonempty",
  "ck_categories_not_self_parent",
];

/** Run `fn(client)` inside a transaction that is always rolled back. */
async function withRollback(fn: (client: PgPoolClient) => Promise<void>) {
  await inRollbackTransaction(fn);
}

/** Every named constraint of every table, as [table, name]. */
async function allConstraints(): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = [];
  for (const table of await objectNames("table")) {
    for (const name of await constraintNames(table)) result.push([table, name]);
  }
  return result;
}

/**
 * Expect `sql` to fail with a check_violation (23514) on `constraint`.
 * Uses a SAVEPOINT so the surrounding fixture transaction stays usable.
 */
async function expectCheckViolation(
  client: PgPoolClient,
  sql: string,
  params: unknown[],
  constraint: string,
) {
  await client.query("SAVEPOINT chk");
  const err = await client.query<DbRow>(sql, params).then(
    () => null,
    (e: unknown) => e,
  );
  await client.query("ROLLBACK TO SAVEPOINT chk");
  await client.query("RELEASE SAVEPOINT chk");
  expect(
    err,
    `expected 23514 from: ${sql} ← ${JSON.stringify(params)}`,
  ).not.toBeNull();
  expect(err).toMatchObject({ code: "23514", constraint });
}

describe("schema naming discipline (migrations 0089 + 0090)", () => {
  // ── 0089: surviving named CHECKs ─────────────────────────────────────────
  it("the surviving 0089 CHECK constraints exist under their pinned names", async () => {
    for (const [table, name] of NEW_CHECKS) {
      const text = await objectSql(must(table, "table"));
      const checks = text.match(new RegExp(`\\bCONSTRAINT\\s+${must(name, "name")}\\s+CHECK\\b`, "gu")) ?? [];
      expect(checks, `${name} on ${table}`).toHaveLength(1);
    }
  });

  it('recurrence_pattern: accepts every SUPPORTED_PATTERNS entry, the "every N days" grammar, case/whitespace variants and NULL', async () => {
    const good = [
      ...getSupportedPatterns(), // real app list — drift fails here
      "every 3 days",
      "every 1 day",
      "every 007 days",
      "Daily", // route stores raw casing; validator lowercases
      "  weekly  ", // validator trims
      null,
    ];
    await withRollback(async (client) => {
      const rec = await client.query<IdRow>(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('_0089_chk', '_0089_chk') RETURNING id`,
      );
      const recipientId = must(rec.rows[0], "rec.rows[0]").id;
      for (const pattern of good) {
        await client.query(
          `INSERT INTO planned_transactions (planned_date, amount, recipient_id, is_recurring, recurrence_pattern)
           VALUES ('2026-01-01', vision_numeric('1', 18, 4), $1, $2, $3)`,
          [recipientId, pattern !== null, pattern],
        );
      }
    });
  });

  it("recurrence_pattern: rejects out-of-vocabulary values including the enum spelling 'bi-weekly'", async () => {
    const bad = [
      "fortnightly",
      "bi-weekly",
      "every 0 days",
      "every days",
      "monthly x",
    ];
    await withRollback(async (client) => {
      const rec = await client.query<IdRow>(
        `INSERT INTO recipients (name, normalized_name)
         VALUES ('_0089_chk_bad', '_0089_chk_bad') RETURNING id`,
      );
      const recipientId = must(rec.rows[0], "rec.rows[0]").id;
      for (const pattern of bad) {
        await expectCheckViolation(
          client,
          `INSERT INTO planned_transactions (planned_date, amount, recipient_id, is_recurring, recurrence_pattern)
           VALUES ('2026-01-01', vision_numeric('1', 18, 4), $1, 1, $2)`,
          [recipientId, pattern],
          "chk_planned_transactions_recurrence_pattern",
        );
      }
    });
  });

  it("portfolio staging match_source and route: accept the pipeline vocabulary + NULL, reject others", async () => {
    await withRollback(async (client) => {
      const batch = await client.query<BigIdRow>(
        `INSERT INTO portfolio_import_batches (adapter_name) VALUES ('_0089_chk') RETURNING id`,
      );
      const batchId = must(batch.rows[0], "batch.rows[0]").id;
      let rowIndex = 0;
      const insert = (matchSource: string | null, route: string | null) =>
        client.query<DbRow>(
          `INSERT INTO portfolio_import_staging_rows (batch_id, row_index, match_source, route)
           VALUES ($1, $2, $3, $4)`,
          [batchId, rowIndex++, matchSource, route],
        );
      // accepted: the matcher's two sources, ADR-095's two routes, NULLs
      for (const matchSource of ["symbol", "name_exact", null]) {
        for (const route of ["cash", "portfolio", null]) {
          await insert(matchSource, route);
        }
      }
      // rejected: the SIBLING table's vocabulary does not leak in
      await expectCheckViolation(
        client,
        `INSERT INTO portfolio_import_staging_rows (batch_id, row_index, match_source)
         VALUES ($1, $2, 'exact')`,
        [batchId, rowIndex++],
        "chk_portfolio_import_staging_rows_match_source",
      );
      await expectCheckViolation(
        client,
        `INSERT INTO portfolio_import_staging_rows (batch_id, row_index, route)
         VALUES ($1, $2, 'ledger')`,
        [batchId, rowIndex++],
        "chk_portfolio_import_staging_rows_route",
      );
    });
  });

  it("provider-neutral source records retain historical source types and admit new adapters", async () => {
    await withRollback(async (client) => {
      let sourceId = process.pid * 1000;
      for (const sourceType of [...RAW_SOURCE_TYPES, "ing", "generic"]) {
        const { rows } = await client.query<DbRow>(
          `INSERT INTO transaction_source_records
             (source_type, legacy_source_id, recorded_at, native_payload)
           VALUES ($1, $2, now(), vision_jsonb('{}')) RETURNING source_type`,
          [sourceType, sourceId++],
        );
        expect(must(rows[0], "rows[0]").source_type).toBe(sourceType);
      }
    });
  });

  it("guarded contracts removed the retired raw references, scalar balance, and hash index", async () => {
    const rows = [
      {
        raw_refs_gone: (await objectType("transaction_raw_references")) === null,
        hash_index_gone: (await objectType("uq_transactions_tx_hash")) === null,
        scalar_gone:
          (await column("accounts", "statement_balance")) === undefined &&
          (await column("accounts", "statement_balance_date")) === undefined,
      },
    ];
    expect(rows[0]).toEqual({
      raw_refs_gone: true,
      hash_index_gone: true,
      scalar_gone: true,
    });
  });

  // ── 0090: renames ────────────────────────────────────────────────────────
  it("every 0090 constraint rename applied: new name present, old name gone", async () => {
    for (const [table, oldName, newName] of CONSTRAINT_RENAMES) {
      const names = (await constraintNames(must(table, "table"))).filter(
        (name) => name === oldName || name === newName,
      );
      expect(names, `${table}: ${oldName} → ${newName}`).toEqual([newName]);
    }
  });

  it("every 0090 index rename applied: new name present (uniqueness preserved), old name gone", async () => {
    for (const [oldName, newName, isUnique] of INDEX_RENAMES) {
      const r = await must(pool, "pool").query<{ name: string; tbl_name: string }>(
        "SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' AND name IN ($1, $2)",
        [oldName, newName],
      );
      expect(
        r.rows.map((row) => row.name),
        `${String(oldName)} → ${String(newName)}`,
      ).toEqual([newName]);
      const found = (await indexes(must(r.rows[0], "r.rows[0]").tbl_name)).find((index) => index.name === newName);
      expect(found?.unique === 1, `${String(newName)} uniqueness`).toBe(isUnique);
    }
  });

  it("no old naming prefixes remain beyond the intentional 0114 category checks", async () => {
    const constraints = await allConstraints();
    expect(
      constraints
        .filter(([table, name]) => table === "categories" && CATEGORY_CHECKS.includes(name))
        .map(([, name]) => name)
        .sort(),
    ).toEqual([...CATEGORY_CHECKS].sort());
    const oldPrefix = /^(ck|uniq|ux|ix)_/u;
    expect(
      constraints.filter(
        ([, name]) => oldPrefix.test(name) && !name.startsWith("legacy_inh_") && !CATEGORY_CHECKS.includes(name),
      ),
    ).toEqual([]);
    const idx = await must(pool, "pool").query<DbRow>(
      `SELECT name AS indexname FROM sqlite_schema
        WHERE type = 'index' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          AND (name LIKE 'uniq\\_%' ESCAPE '\\' OR name LIKE 'ux\\_%' ESCAPE '\\'
               OR name LIKE 'ix\\_%' ESCAPE '\\' OR name LIKE '%\\_idx' ESCAPE '\\')
          AND name NOT LIKE 'legacy\\_inh\\_%' ESCAPE '\\'
          AND tbl_name NOT IN ('investments_legacy', 'portfolio_transactions_legacy')`,
    );
    expect(idx.rows).toEqual([]);
  });
});
