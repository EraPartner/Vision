#!/usr/bin/env bun

/**
 * Read-only status report for the six out-of-band legacy database contracts.
 *
 * The report contains schema shapes and aggregate counts only. It never prints
 * a connection string, SQL text from other sessions, or application data.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

function parseEnv(contents) {
  const values = {};
  for (const line of String(contents).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    values[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim();
  }
  return values;
}

async function resolveConnectionString() {
  if (process.argv.includes("--native")) {
    const nativeEnvPath = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Vision",
      "native",
      "vision",
      `runtime${".env"}`,
    );
    const values = parseEnv(readFileSync(nativeEnvPath, "utf8"));
    const nativeUrl = values.DATABASE_URL_MIGRATIONS ?? values.DATABASE_URL;
    if (!nativeUrl) {
      throw new Error(
        "The maintained native Vision runtime has no database URL",
      );
    }
    return nativeUrl;
  }
  const { default: settings } = await import("../src/config/config.js");
  return settings.database.migrationsUrl ?? settings.database.url;
}

const connectionString = await resolveConnectionString();

const client = new Client({
  connectionString,
  statement_timeout: 60_000,
  application_name: "vision-legacy-retirement-status",
});

const legacyRawSources = [
  ["belfius", "belfius_raw_transactions"],
  ["revolut", "revolut_raw_transactions"],
  ["kbc", "kbc_raw_transactions"],
  ["sabb", "sabb_raw_transactions"],
  ["wise", "wise_raw_transactions"],
  ["vision", "vision_raw_transactions"],
  ["custom", "custom_raw_transactions"],
  ["manual", "manual_raw_transactions"],
];

const adr109Views = [
  "stock_investments_full",
  "etf_investments_full",
  "crypto_investments_full",
  "real_estate_investments_full",
  "savings_investments_full",
  "bond_investments_full",
  "legacy_inh_portfolio_transactions",
  "legacy_inh_investments",
];

const adr109RequiredTables = [
  "legacy_inh_stock_transactions",
  "legacy_inh_etf_transactions",
  "legacy_inh_crypto_transactions",
  "legacy_inh_metals_transactions",
  "legacy_inh_real_estate_transactions",
  "legacy_inh_savings_transactions",
  "legacy_inh_bond_transactions",
  "legacy_inh_portfolio_transactions_base",
  "legacy_inh_stock_investments",
  "legacy_inh_etf_investments",
  "legacy_inh_crypto_investments",
  "legacy_inh_metals_investments",
  "legacy_inh_real_estate_investments",
  "legacy_inh_savings_investments",
  "legacy_inh_bond_investments",
  "legacy_inh_investments_base",
];

const adr109OptionalTables = [
  "portfolio_transactions_legacy",
  "investments_legacy",
];

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function scalar(sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0]?.value;
}

async function relationKind(name) {
  return scalar(
    `SELECT relkind::text AS value
      FROM pg_class
      WHERE oid = to_regclass(format('public.%I', $1::text))`,
    [name],
  );
}

async function relationCount(name) {
  if ((await relationKind(name)) === undefined) return undefined;
  return Number(
    await scalar(
      `SELECT count(*)::text AS value FROM ${quoteIdentifier(name)}`,
    ),
  );
}

async function columnExists(table, column) {
  return Boolean(
    await scalar(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
       ) AS value`,
      [table, column],
    ),
  );
}

async function columnStatus(table, column) {
  const exists = await columnExists(table, column);
  return {
    exists,
    nonNullRows: exists
      ? Number(
          await scalar(
            `SELECT count(*)::text AS value FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`,
          ),
        )
      : 0,
  };
}

async function providerRawStatus() {
  const sources = {};
  let parityMismatches = 0;
  let completeShape = true;
  const neutralExists =
    (await relationKind("transaction_source_records")) === "r";

  for (const [sourceType, table] of legacyRawSources) {
    const kind = await relationKind(table);
    const count = kind === undefined ? 0 : await relationCount(table);
    const neutralCount = neutralExists
      ? Number(
          await scalar(
            `SELECT count(*)::text AS value
               FROM transaction_source_records
              WHERE source_type = $1
                AND NOT (native_payload ? 'missing_legacy_source')`,
            [sourceType],
          ),
        )
      : 0;
    let payloadMismatches = undefined;
    if (kind === "r" && neutralExists) {
      payloadMismatches = Number(
        await scalar(
          `SELECT count(*)::text AS value
             FROM ${quoteIdentifier(table)} old
             JOIN transaction_source_records archived
               ON archived.source_type = $1
              AND archived.legacy_source_id = old.id
            WHERE archived.native_payload IS DISTINCT FROM to_jsonb(old)`,
          [sourceType],
        ),
      );
      parityMismatches += Math.abs(count - neutralCount) + payloadMismatches;
    } else if (kind !== undefined) {
      completeShape = false;
    }
    sources[table] = {
      kind: kind ?? "absent",
      count,
      neutralCount,
      payloadMismatches,
    };
  }

  const referenceKind = await relationKind("transaction_raw_references");
  const legacyLinks =
    referenceKind === "r"
      ? await relationCount("transaction_raw_references")
      : 0;
  const neutralLinks =
    (await relationKind("transaction_source_links")) === "r"
      ? await relationCount("transaction_source_links")
      : 0;
  if (referenceKind !== undefined && legacyLinks !== neutralLinks) {
    parityMismatches += Math.abs(legacyLinks - neutralLinks);
  }

  return {
    sources,
    links: { legacy: legacyLinks, neutral: neutralLinks },
    completeShape,
    parityMismatches,
    databaseGate: completeShape && parityMismatches === 0,
  };
}

async function adr109Status() {
  const relations = {};
  for (const name of [
    ...adr109Views,
    ...adr109RequiredTables,
    ...adr109OptionalTables,
  ]) {
    const kind = await relationKind(name);
    if (kind !== undefined) {
      relations[name] = { kind, count: await relationCount(name) };
    }
  }
  return {
    cleanupMarker: (await relationKind("adr109_legacy_cleanup_marker")) === "r",
    archive: (await relationKind("adr109_legacy_archive")) === "r",
    residueRelations: relations,
    expectedResidueCount: adr109Views.length + adr109RequiredTables.length,
    optionalResidueRelations: adr109OptionalTables,
    canonical: {
      investments: {
        kind: (await relationKind("investments")) ?? "absent",
        count: (await relationCount("investments")) ?? 0,
      },
      portfolioTransactions: {
        kind: (await relationKind("portfolio_transactions")) ?? "absent",
        count: (await relationCount("portfolio_transactions")) ?? 0,
      },
    },
  };
}

async function bankAccountStatus() {
  const transactions = await columnStatus("transactions", "bank_account");
  const planned = await columnStatus("planned_transactions", "bank_account");
  let parityMismatches = 0;
  if (transactions.exists) {
    parityMismatches += Number(
      await scalar(
        `SELECT count(*)::text AS value
           FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.account_id IS NULL OR a.id IS NULL
             OR (t.bank_account IS NOT NULL
                 AND lower(btrim(t.bank_account)) <> lower(btrim(a.name)))`,
      ),
    );
  }
  if (planned.exists) {
    parityMismatches += Number(
      await scalar(
        `SELECT count(*)::text AS value
           FROM planned_transactions p LEFT JOIN accounts a ON a.id = p.account_id
          WHERE p.account_id IS NULL OR a.id IS NULL
             OR (p.bank_account IS NOT NULL
                 AND lower(btrim(p.bank_account)) <> lower(btrim(a.name)))`,
      ),
    );
  }
  return {
    transactions,
    plannedTransactions: planned,
    parityMismatches,
    alreadyRetired: !transactions.exists && !planned.exists,
  };
}

async function statementScalarStatus() {
  const balance = await columnStatus("accounts", "statement_balance");
  const date = await columnStatus("accounts", "statement_balance_date");
  let parityMismatches = 0;
  if (balance.exists && date.exists) {
    parityMismatches = Number(
      await scalar(
        `SELECT count(*)::text AS value
           FROM accounts a
           LEFT JOIN account_statement_balances sb
             ON sb.account_id = a.id AND sb.currency = a.currency
          WHERE (a.statement_balance IS NULL) <> (a.statement_balance_date IS NULL)
             OR (a.statement_balance IS NOT NULL AND (
                  sb.account_id IS NULL
               OR sb.balance IS DISTINCT FROM a.statement_balance
               OR sb.balance_date IS DISTINCT FROM a.statement_balance_date))`,
      ),
    );
  }
  return {
    statementBalance: balance,
    statementBalanceDate: date,
    parityMismatches,
    alreadyRetired: !balance.exists && !date.exists,
  };
}

async function stagingTxHashStatus(table, batchTable) {
  const status = await columnStatus(table, "tx_hash");
  if (!status.exists || status.nonNullRows === 0) {
    return { ...status, fingerprintedRows: 0, terminalBatchRows: 0 };
  }
  const fingerprintedRows = Number(
    await scalar(
      `SELECT count(*)::text AS value
         FROM ${quoteIdentifier(table)}
        WHERE tx_hash IS NOT NULL
          AND dedup_fingerprint IS NOT NULL
          AND dedup_fingerprint_version IS NOT NULL`,
    ),
  );
  const terminalBatchRows = Number(
    await scalar(
      `SELECT count(*)::text AS value
         FROM ${quoteIdentifier(table)} AS staging
         JOIN ${quoteIdentifier(batchTable)} AS batch ON batch.id = staging.batch_id
        WHERE staging.tx_hash IS NOT NULL
          AND batch.status IN ('complete', 'failed', 'aborted')`,
    ),
  );
  const nonTerminalBatches = (
    await client.query(
      `SELECT batch.id, batch.adapter_name, batch.status,
              count(*)::int AS tx_hash_rows
         FROM ${quoteIdentifier(table)} AS staging
         JOIN ${quoteIdentifier(batchTable)} AS batch ON batch.id = staging.batch_id
        WHERE staging.tx_hash IS NOT NULL
          AND batch.status NOT IN ('complete', 'failed', 'aborted')
        GROUP BY batch.id, batch.adapter_name, batch.status
        ORDER BY batch.id`,
    )
  ).rows;
  return {
    ...status,
    fingerprintedRows,
    terminalBatchRows,
    nonTerminalBatches,
  };
}

async function recurrenceEnumStatus() {
  const oid = await scalar(
    "SELECT to_regtype('public.recurrence_interval')::oid::text AS value",
  );
  if (oid === undefined || oid === null)
    return { exists: false, dependencies: 0 };
  const dependencies = Number(
    await scalar(
      `SELECT count(*)::text AS value
         FROM pg_depend
        WHERE refobjid = $1::oid
          AND deptype IN ('n', 'a', 'i')
          AND NOT (
            classid = 'pg_type'::regclass
            AND objid = (SELECT typarray FROM pg_type WHERE oid = $1::oid)
            AND deptype = 'i')`,
      [oid],
    ),
  );
  return { exists: true, dependencies };
}

await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  const target = (
    await client.query(
      `SELECT current_database() AS database,
              current_user AS role,
              COALESCE(inet_server_addr()::text, 'local-socket') AS server_address,
              inet_server_port() AS server_port,
              current_setting('server_version') AS server_version,
              pg_is_in_recovery() AS in_recovery`,
    )
  ).rows[0];
  const alembicRevisions = (
    await client.query(
      "SELECT version_num FROM alembic_version ORDER BY version_num",
    )
  ).rows.map((row) => row.version_num);
  const sessions = (
    await client.query(
      `SELECT COALESCE(NULLIF(application_name, ''), '(unset)') AS application,
              state,
              count(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
        GROUP BY application_name, state
        ORDER BY application, state`,
    )
  ).rows;

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    target,
    alembicRevisions,
    sessions,
    providerRaw: await providerRawStatus(),
    adr109: await adr109Status(),
    txHash: {
      transactions: await columnStatus("transactions", "tx_hash"),
      importStagingRows: await stagingTxHashStatus(
        "import_staging_rows",
        "import_batches",
      ),
      portfolioImportStagingRows: await stagingTxHashStatus(
        "portfolio_import_staging_rows",
        "portfolio_import_batches",
      ),
      elapsedTimeSoak:
        "waived by the maintained-installation operator on 2026-09-13",
    },
    bankAccount: await bankAccountStatus(),
    statementScalars: await statementScalarStatus(),
    recurrenceEnum: await recurrenceEnumStatus(),
  };
  console.log(JSON.stringify(report, null, 2));
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`[legacy-retirement-status] ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
