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
  const first = await loadGenerator();
  const second = await loadGenerator();
  assert.equal(first.demoSeedSql, second.demoSeedSql);
  assert.deepEqual(first.demoSeedSummary, second.demoSeedSummary);
  assert.doesNotMatch(first.demoSeedSql, /\balembic_version\b/i);
  assert.match(first.demoSeedSql, /onboarding_complete/);
  assert.equal(sha256(first.demoSeedSql).length, 64);
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
