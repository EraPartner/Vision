import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { appRoot } from "../paths";
import { loadDemoSeed } from "../runtime/native-demo";
import {
  assertSafeDemoSeedDestination,
  assertSummaryMatchesStats,
  buildDemoSeed,
  loadGenerator,
  sha256,
} from "./build-demo-seed";
import type { DemoSeedRuntime } from "./build-demo-seed";

const repoRoot = path.resolve(appRoot, "..", "..");

interface GeneratorModule {
  DEMO_DECIMAL_COLUMNS: Readonly<Record<string, number>>;
  decimalText: (value: number, d: number, scale: number) => string;
}

async function generatorModule(): Promise<GeneratorModule> {
  const loaded = await loadGenerator("2026-09-03");
  assert.ok("DEMO_DECIMAL_COLUMNS" in loaded && "decimalText" in loaded);
  return loaded as unknown as GeneratorModule;
}

async function loadSql(referenceDate: string): Promise<string> {
  const { demoSeedSql } = await loadGenerator(referenceDate);
  assert.equal(typeof demoSeedSql, "string");
  return String(demoSeedSql);
}

void test("Demo seed transfer rows survive the startup transfer reconciler", async () => {
  // The backend's reconciler releases every is_transfer row with source
  // 'auto' or 'manual' that has no peer, turning it into income or spending.
  // The seed never writes transfer_peer_id, so it must flag only system-owned
  // transfer rows (for example the liability principal paydowns).
  const sql = await loadSql("2026-06-17");
  const rows = sql
    .split("\n")
    .filter((line) => line.startsWith("INSERT INTO transactions ("));
  assert.ok(rows.length > 0);
  const flagged = rows
    .map((line) => /,([01]),(NULL|'[a-z]+')\);$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter(([, isTransfer]) => isTransfer === "1");
  assert.equal(
    rows.filter((line) => /,([01]),(NULL|'[a-z]+')\);$/.test(line)).length,
    rows.length,
  );
  assert.ok(flagged.length > 0, "expected the liability paydown rows");
  for (const [, , source] of flagged) {
    assert.ok(
      source !== "NULL" && !["'auto'", "'manual'"].includes(source ?? ""),
      `unpaired transfer row uses reconciler-owned source ${source}`,
    );
  }
});

void test("Demo seed destinations are explicit generated directories", () => {
  assert.equal(
    assertSafeDemoSeedDestination(
      path.join(os.tmpdir(), "vision-build", "demo-seed"),
    ),
    path.join(os.tmpdir(), "vision-build", "demo-seed"),
  );
  assert.throws(
    () => assertSafeDemoSeedDestination(path.join(os.tmpdir(), "vision-build")),
    /must end in demo-seed/,
  );
});

void test("the synthetic generator is deterministic data-only SQL", async () => {
  const first = await loadGenerator("2026-09-03");
  const second = await loadGenerator("2026-09-03");
  assert.equal(first.demoSeedSql, second.demoSeedSql);
  assert.deepEqual(first.demoSeedSummary, second.demoSeedSummary);
  assert.equal(first.demoSeedReferenceDate, "2026-09-03");
  assert.equal(typeof first.demoSeedSql, "string");
  const firstSql = String(first.demoSeedSql);
  assert.doesNotMatch(firstSql, /\b(?:kysely_migration|vision_migrations)\b/i);
  assert.doesNotMatch(
    firstSql,
    /\bstatement_balance_date\b|\bbank_account,recipient_id\b/,
  );
  assert.match(
    firstSql,
    /INSERT INTO transactions \(id,date,amount,currency,account_id,/,
  );
  assert.match(firstSql, /onboarding_complete/);
  assert.equal(sha256(firstSql).length, 64);
});

void test("demo planned loans use a loan type the API contract accepts", async () => {
  // openapi PlannedLoanType; a strict client rejects the whole planned list on any other.
  const demoSeedSql = await loadSql("2026-09-03");
  const loanTypes = demoSeedSql
    .split("\n")
    .filter((line) => /^INSERT INTO planned_transactions \(/.test(line))
    .flatMap((line) => [
      ...line.matchAll(/'(amortizing|fixed_principal|interest_only|annuity)'/g),
    ])
    .map((match) => match[1]);
  assert.ok(loanTypes.length > 0);
  for (const loanType of loanTypes) {
    assert.ok(
      ["amortizing", "fixed_principal", "interest_only"].includes(
        String(loanType),
      ),
      `unsupported loan_type ${loanType}`,
    );
  }
});

void test("hierarchy root IDs cannot collide with explicit demo category IDs", async () => {
  const demoSeedSql = await loadSql("2026-09-03");
  const lines = demoSeedSql.split("\n");
  const categoryIds = lines
    .map((line) =>
      /^INSERT INTO categories \(id,/.test(line)
        ? Number(line.match(/VALUES \((\d+),/)?.[1])
        : undefined,
    )
    .filter((id): id is number => id !== undefined);
  const beforeLeaf = lines.findIndex((line) =>
    line.startsWith("INSERT INTO categories (id,"),
  );
  assert.ok(categoryIds.length > 0);
  assert.equal(
    lines[beforeLeaf - 1],
    `UPDATE sqlite_sequence SET seq=max(seq,${Math.max(...categoryIds)}) WHERE name='categories';`,
  );
  assert.match(
    String(lines[beforeLeaf - 2]),
    /^INSERT INTO sqlite_sequence \(name,seq\) SELECT 'categories',0 WHERE NOT EXISTS/,
  );
});

void test("the seed uses SQLite literal forms only", async () => {
  const demoSeedSql = await loadSql("2026-09-03");
  assert.doesNotMatch(demoSeedSql, /::|\bsetval\b|\bnextval\b|\bpublic\./);
  for (const line of demoSeedSql.split("\n")) {
    // Outside string literals, booleans are 0/1 and nothing is a float.
    const code = line.replace(/'(?:[^']|'')*'/g, "''");
    assert.doesNotMatch(code, /\b(?:true|false)\b/i, line.slice(0, 120));
    assert.doesNotMatch(code, /\b\d+\.\d+\b/, line.slice(0, 120));
  }
  assert.match(
    demoSeedSql,
    /'belgian_tax_profile', vision_jsonb\('\{"profileConfigured":true,/,
  );
  assert.match(
    demoSeedSql,
    /INSERT INTO vision_sequences \(name,last_value\) VALUES \('portfolio_transactions_id_seq',\d+\)/,
  );
});

void test("decimal literals are canonical text at the column scale", async () => {
  const { decimalText } = await generatorModule();
  assert.equal(decimalText(12.5, 2, 4), "12.5000");
  assert.equal(decimalText(-932.6081, 2, 4), "-932.6100");
  assert.equal(decimalText(-0.001, 2, 4), "0.0000");
  assert.equal(decimalText(1, 10, 10), "1.0000000000");
  assert.equal(decimalText(1450, 2, 2), "1450.00");
  assert.throws(() => decimalText(1.23456, 6, 4), /does not fit scale/);
  assert.throws(() => decimalText(Number.NaN, 2, 4), /does not fit scale/);
});

/**
 * DECIMAL_TEXT(p,s) (or, before ADR-263, numeric(p,s)) scale of every column
 * the migrations declare, by "table.column"; later migrations win.
 */
function declaredDecimalScales(): Map<string, number> {
  const dir = path.join(repoRoot, "db", "migrations");
  const scales = new Map<string, number>();
  const name = String.raw`"?(?:public"?\.")?([a-z_][a-z0-9_]*)"?`;
  const decimal = String.raw`(?:numeric|DECIMAL_TEXT)\((\d+),\s*(\d+)\)`;
  const createTable = new RegExp(
    String.raw`CREATE TABLE (?:IF NOT EXISTS )?${name}\s*\(([\s\S]*?)\n\);`,
    "gi",
  );
  const column = new RegExp(String.raw`^\s*"?([a-z_][a-z0-9_]*)"?\s+${decimal}`, "gim");
  const addColumn = new RegExp(
    String.raw`ALTER TABLE (?:ONLY )?${name}\s+ADD COLUMN (?:IF NOT EXISTS )?"?([a-z_][a-z0-9_]*)"?\s+${decimal}`,
    "gi",
  );
  const alterType = new RegExp(
    String.raw`ALTER TABLE (?:ONLY )?${name}\s+ALTER COLUMN "?([a-z_][a-z0-9_]*)"?\s+(?:SET DATA )?TYPE\s+${decimal}`,
    "gi",
  );
  const files = fs
    .readdirSync(dir)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file) && !file.endsWith(".down.sql"))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    for (const [, rawTable = "", body = ""] of sql.matchAll(createTable)) {
      // A SQLite table rebuild creates <table>__new and renames it.
      const table = rawTable.replace(/__?new$/, "");
      for (const [, col = "", , scale = ""] of body.matchAll(column))
        scales.set(`${table}.${col}`, Number(scale));
    }
    for (const pattern of [addColumn, alterType]) {
      for (const [, table = "", col = "", , scale = ""] of sql.matchAll(pattern))
        scales.set(`${table}.${col}`, Number(scale));
    }
  }
  return scales;
}

void test("the generator's decimal scales match the migrated schema", async () => {
  const { DEMO_DECIMAL_COLUMNS } = await generatorModule();
  const declared = declaredDecimalScales();
  assert.ok(declared.size > 0, "no decimal columns found in db/migrations");
  for (const [columnName, scale] of Object.entries(DEMO_DECIMAL_COLUMNS)) {
    assert.equal(declared.get(columnName), scale, columnName);
  }
});

void test("the reference date shifts historical and planned rows together", async () => {
  const earlier = { demoSeedSql: await loadSql("2026-09-03") };
  const later = { demoSeedSql: await loadSql("2026-10-03") };

  assert.notEqual(earlier.demoSeedSql, later.demoSeedSql);
  const transactionDates = [
    ...earlier.demoSeedSql.matchAll(
      /INSERT INTO transactions \([^\n]+ VALUES \([^,]+,'(\d{4}-\d{2}-\d{2})'/g,
    ),
  ].map((match) => String(match[1]));
  assert.ok(transactionDates.length > 0);
  assert.ok(transactionDates.every((date) => date <= "2026-09-03"));

  const plannedDates = [
    ...earlier.demoSeedSql.matchAll(
      /INSERT INTO planned_transactions \([^\n]+ VALUES \([^,]+,'(\d{4}-\d{2}-\d{2})'/g,
    ),
  ].map((match) => String(match[1]));
  assert.ok(plannedDates.some((date) => date >= "2026-09-03"));
  assert.ok(plannedDates.some((date) => date > "2026-09-03"));

  assert.match(
    later.demoSeedSql,
    /account_statement_balances \(account_id,currency,balance,balance_date\) VALUES \([^\n]+'2026-10-03'/,
  );
});

void test("year-bearing demo labels and tax settings follow a year shift", async () => {
  const earlier = { demoSeedSql: await loadSql("2026-09-03") };
  const later = { demoSeedSql: await loadSql("2027-09-03") };

  assert.match(earlier.demoSeedSql, /Belgische Staatsbon 2027/);
  assert.match(later.demoSeedSql, /Belgische Staatsbon 2028/);
  assert.match(earlier.demoSeedSql, /"mortgageStartYear":2018/);
  assert.match(later.demoSeedSql, /"mortgageStartYear":2019/);
});

void test("the generator rejects an invalid reference calendar date", async () => {
  await assert.rejects(
    () => loadGenerator("2026-02-30"),
    /referenceDate must be an ISO calendar date/,
  );
});

void test("seed build rejects generated row-count drift", () => {
  const summary = {
    accounts: 6,
    transactions: 10,
    recipients: 4,
    investments: 3,
    portfolioTransactions: 2,
    assetPriceHistory: 5,
    plannedTransactions: 1,
    transactionSplits: 0,
  };
  const tableCounts = {
    accounts: 6,
    transactions: 10,
    recipients: 4,
    investments: 3,
    portfolio_transactions: 2,
    asset_price_history: 5,
    planned_transactions: 1,
    transaction_splits: 0,
  };
  assert.doesNotThrow(() =>
    assertSummaryMatchesStats(summary, { tableCounts }),
  );
  assert.throws(
    () =>
      assertSummaryMatchesStats(summary, {
        tableCounts: { ...tableCounts, transactions: 11 },
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "DEMO_SEED_COUNT_MISMATCH",
  );
});

const syntheticSummary = {
  accounts: 1,
  transactions: 2,
  recipients: 1,
  investments: 0,
  portfolioTransactions: 0,
  assetPriceHistory: 0,
  plannedTransactions: 0,
  transactionSplits: 0,
};

function syntheticTableCounts() {
  return {
    accounts: 1,
    transactions: 2,
    recipients: 1,
    investments: 0,
    portfolio_transactions: 0,
    asset_price_history: 0,
    planned_transactions: 0,
    transaction_splits: 0,
    categories: 3,
  };
}

async function seedBuildFixture(t: TestContext) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "vision-demo-seed-build-"),
  );
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const payload = path.join(root, "native-runtime");
  await fs.promises.mkdir(payload);
  await fs.promises.writeFile(path.join(payload, "manifest.json"), "{}");
  return { payload, outputRoot: path.join(root, "demo-seed") };
}

function fakeRuntime(
  seen: unknown[],
  overrides: Partial<Awaited<ReturnType<DemoSeedRuntime["createDatabaseFile"]>>> = {},
): DemoSeedRuntime {
  return {
    ensureLayout: () => Promise.resolve(),
    discover: () => Promise.resolve(),
    async createDatabaseFile(destination, { seedSqlPath }) {
      seen.push(await fs.promises.readFile(seedSqlPath, "utf8"));
      const contents = Buffer.from("SQLite format 3\0synthetic Demo");
      await fs.promises.writeFile(destination, contents);
      return {
        sha256: sha256(contents),
        bytes: contents.length,
        schemaVersion: 7,
        sqliteVersion: "3.46.1",
        pendingMigrations: 0,
        tableCounts: syntheticTableCounts(),
        ...overrides,
      };
    },
  };
}

void test("the seed build writes a SQLite seed the Demo runtime accepts", async (t) => {
  const { payload, outputRoot } = await seedBuildFixture(t);
  const seen: unknown[] = [];
  const created: unknown[] = [];
  const sql = "INSERT INTO accounts (id,name) VALUES (1,'Synthetic');\n";
  const result = await buildDemoSeed({
    nativeRuntimeRoot: payload,
    outputRoot,
    createRuntime: (options) => {
      created.push(options);
      return fakeRuntime(seen);
    },
    load: () =>
      Promise.resolve({
        demoSeedSql: sql,
        demoSeedSummary: syntheticSummary,
        demoSeedReferenceDate: "2026-09-03",
      }),
  });
  assert.deepEqual(seen, [sql]);
  assert.equal(
    (created[0] as { runtimeRoot?: unknown }).runtimeRoot,
    path.resolve(payload),
  );
  assert.equal(
    (created[0] as { requireRuntimeManifest?: unknown }).requireRuntimeManifest,
    true,
  );
  assert.deepEqual(fs.readdirSync(outputRoot).sort(), [
    "manifest.json",
    "vision-demo.sqlite3",
  ]);
  const seed = await loadDemoSeed(outputRoot);
  assert.deepEqual(seed.manifest, result.manifest);
  assert.equal(seed.manifest.schemaVersion, 7);
  assert.equal(seed.manifest.logicalSha256, sha256(sql));
  assert.deepEqual(seed.manifest.database.tableCounts, syntheticTableCounts());
});

void test("the seed build refuses SQL that writes migration state", async (t) => {
  const { payload, outputRoot } = await seedBuildFixture(t);
  await assert.rejects(
    buildDemoSeed({
      nativeRuntimeRoot: payload,
      outputRoot,
      createRuntime: () => fakeRuntime([]),
      load: () =>
        Promise.resolve({
          demoSeedSql: "DELETE FROM vision_migrations;\n",
          demoSeedSummary: syntheticSummary,
        }),
    }),
    /must not modify migration state/,
  );
  assert.equal(fs.existsSync(outputRoot), false);
});

void test("the seed build refuses a database behind the packaged migrations", async (t) => {
  const { payload, outputRoot } = await seedBuildFixture(t);
  await assert.rejects(
    buildDemoSeed({
      nativeRuntimeRoot: payload,
      outputRoot,
      createRuntime: () => fakeRuntime([], { pendingMigrations: 1 }),
      load: () =>
        Promise.resolve({
          demoSeedSql: "SELECT 1;\n",
          demoSeedSummary: syntheticSummary,
        }),
    }),
    /not at the packaged schema version/,
  );
  assert.equal(fs.existsSync(outputRoot), false);
});
