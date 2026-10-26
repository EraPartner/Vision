import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeDemoSeedDestination,
  assertSummaryMatchesStats,
  loadGenerator,
  sha256,
} from "./build-demo-seed";

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
    .map((line) => /,(true|false),(NULL|'[a-z]+')\);$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter(([, isTransfer]) => isTransfer === "true");
  assert.equal(
    rows.filter((line) => /,(true|false),(NULL|'[a-z]+')\);$/.test(line))
      .length,
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
  assert.doesNotMatch(firstSql, /\bkysely_migration\b/i);
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
    `SELECT setval('public.categories_id_seq',${Math.max(...categoryIds)},true);`,
  );
  assert.match(
    demoSeedSql,
    /SELECT setval\('public.categories_id_seq',\(SELECT MAX\(id\) FROM categories\),true\);/,
  );
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
