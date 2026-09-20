"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertSafeDemoSeedDestination,
  assertSummaryMatchesStats,
  loadGenerator,
  sha256,
} = require("./build-demo-seed");

test("Demo seed destinations are explicit generated directories", () => {
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

test("the synthetic generator is deterministic data-only SQL", async () => {
  const first = await loadGenerator("2026-09-03");
  const second = await loadGenerator("2026-09-03");
  assert.equal(first.demoSeedSql, second.demoSeedSql);
  assert.deepEqual(first.demoSeedSummary, second.demoSeedSummary);
  assert.equal(first.demoSeedReferenceDate, "2026-09-03");
  assert.doesNotMatch(first.demoSeedSql, /\balembic_version\b/i);
  assert.doesNotMatch(
    first.demoSeedSql,
    /\bstatement_balance_date\b|\bbank_account,recipient_id\b/,
  );
  assert.match(
    first.demoSeedSql,
    /INSERT INTO transactions \(id,date,amount,currency,account_id,/,
  );
  assert.match(first.demoSeedSql, /onboarding_complete/);
  assert.equal(sha256(first.demoSeedSql).length, 64);
});

test("hierarchy root IDs cannot collide with explicit demo category IDs", async () => {
  const { demoSeedSql } = await loadGenerator("2026-09-03");
  const lines = demoSeedSql.split("\n");
  const categoryIds = lines
    .map((line) =>
      /^INSERT INTO categories \(id,/.test(line)
        ? Number(line.match(/VALUES \((\d+),/)?.[1])
        : undefined,
    )
    .filter((id) => id !== undefined);
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

test("the reference date shifts historical and planned rows together", async () => {
  const earlier = await loadGenerator("2026-09-03");
  const later = await loadGenerator("2026-10-03");

  assert.notEqual(earlier.demoSeedSql, later.demoSeedSql);
  const transactionDates = [
    ...earlier.demoSeedSql.matchAll(
      /INSERT INTO transactions \([^\n]+ VALUES \([^,]+,'(\d{4}-\d{2}-\d{2})'/g,
    ),
  ].map((match) => match[1]);
  assert.ok(transactionDates.length > 0);
  assert.ok(transactionDates.every((date) => date <= "2026-09-03"));

  const plannedDates = [
    ...earlier.demoSeedSql.matchAll(
      /INSERT INTO planned_transactions \([^\n]+ VALUES \([^,]+,'(\d{4}-\d{2}-\d{2})'/g,
    ),
  ].map((match) => match[1]);
  assert.ok(plannedDates.some((date) => date >= "2026-09-03"));
  assert.ok(plannedDates.some((date) => date > "2026-09-03"));

  assert.match(
    later.demoSeedSql,
    /account_statement_balances \(account_id,currency,balance,balance_date\) VALUES \([^\n]+'2026-10-03'/,
  );
});

test("year-bearing demo labels and tax settings follow a year shift", async () => {
  const earlier = await loadGenerator("2026-09-03");
  const later = await loadGenerator("2027-09-03");

  assert.match(earlier.demoSeedSql, /Belgische Staatsbon 2027/);
  assert.match(later.demoSeedSql, /Belgische Staatsbon 2028/);
  assert.match(earlier.demoSeedSql, /"mortgageStartYear":2018/);
  assert.match(later.demoSeedSql, /"mortgageStartYear":2019/);
});

test("the generator rejects an invalid reference calendar date", async () => {
  await assert.rejects(
    () => loadGenerator("2026-02-30"),
    /referenceDate must be an ISO calendar date/,
  );
});

test("seed build rejects generated row-count drift", () => {
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
    (error) => error.code === "DEMO_SEED_COUNT_MISMATCH",
  );
});
