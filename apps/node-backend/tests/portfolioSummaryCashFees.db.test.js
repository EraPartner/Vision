/**
 * Source-owned account fees are additive reporting, never security cost basis.
 * Requires a migrated disposable database with DATABASE_URL=TEST_DATABASE_URL.
 * Only this suite's tracked fixtures are removed; no actual data is accessed.
 */
import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.ts";
import { getPortfolioSummary } from "../src/services/portfolio/portfolioSummaryService.ts";
import { __CASH_SNAPSHOT_SQL as CASH_SNAPSHOT_SQL } from "../src/repositories/portfolioImportCashRepository.ts";
import { cashFeeFingerprint } from "../src/services/portfolioKinesisCashScope.ts";

// Historical conversion still reads the real exchange_rates table. Only a
// missing-rate fallback is controlled, so this suite never requests live FX.
vi.mock("../src/services/currency/currencyConversionService.ts", () => ({
  convertToCurrency: vi.fn(async (amount, from, to) => {
    if (from === to) return amount;
    if (from === "USD" && to === "EUR") return amount * 0.9;
    if (from === "EUR" && to === "USD") return amount / 0.9;
    throw new Error(`Unexpected synthetic currency pair: ${from}/${to}`);
  }),
}));

const pool = getTestPool();
const owned = {
  accounts: [],
  batches: [],
  transactions: [],
  investments: [],
  recipients: [],
  categories: [],
  rates: [],
};
let sequence = 0;
const cutoff = "2025-01-31";
const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
const tag = () => `Summary cash fees ${++sequence}`;
const summary = (throughDate = cutoff) =>
  getPortfolioSummary("EUR", { throughDate });

async function account() {
  const { rows } = await pool.query(
    "INSERT INTO accounts(name,type,currency) VALUES($1,'brokerage','EUR') RETURNING id",
    [tag()],
  );
  owned.accounts.push(rows[0].id);
  return rows[0].id;
}

async function batch(accountId, options = {}) {
  const format = options.format ?? "ibkr_transaction_history";
  const { rows } = await pool.query(
    `INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage)
     VALUES($1,$2,$3,1,$4,true) RETURNING id`,
    [
      format,
      JSON.stringify({ format }),
      options.status ?? "complete",
      accountId,
    ],
  );
  owned.batches.push(rows[0].id);
  return rows[0].id;
}

async function cash(accountId, options = {}) {
  const label = tag();
  const { rows: recipients } = await pool.query(
    "INSERT INTO recipients(name,normalized_name) VALUES($1,$2) RETURNING id",
    [label, label.toLowerCase()],
  );
  owned.recipients.push(recipients[0].id);
  const { rows } = await pool.query(
    `INSERT INTO transactions(date,amount,currency,memo,account_id,recipient_id,
       balance,is_active,is_transfer,transfer_source,source_record_hash,
       dedup_fingerprint,dedup_fingerprint_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1) RETURNING id`,
    [
      options.date ?? "2025-01-10",
      options.amount ?? -3,
      options.currency ?? "EUR",
      label,
      accountId,
      recipients[0].id,
      options.balance ?? null,
      options.isActive ?? true,
      options.isTransfer ?? false,
      options.transferSource ?? null,
      options.sourceHash ?? hash(`${label}:source`),
      options.fingerprint ?? hash(`${label}:fingerprint`),
    ],
  );
  owned.transactions.push(rows[0].id);
  return (
    await pool.query(
      `SELECT ${CASH_SNAPSHOT_SQL} AS snapshot FROM transactions t WHERE t.id=$1`,
      [rows[0].id],
    )
  ).rows[0].snapshot;
}

async function source(batchId, current, options = {}) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,
       amount,fees,taxes,currency,raw_data,committed_txn_id,source_record_hash,
       dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
     VALUES($1,0,$2,$3,'Fee',$4,'cash',$5,0,0,$6,$7,$8,$9,$10,1,1) RETURNING id`,
    [
      batchId,
      options.status ?? "committed",
      options.date ?? current.date,
      options.type === undefined ? "fee" : options.type,
      Math.abs(Number(current.amount)),
      current.currency,
      options.rawData ?? "synthetic literal fee record",
      options.committedId === undefined ? current.id : options.committedId,
      options.sourceHash ?? current.source_record_hash,
      current.dedup_fingerprint,
    ],
  );
  return rows[0].id;
}

async function ownedFee(accountId, options = {}) {
  const current = await cash(accountId, options);
  const batchId = await batch(accountId, options.batch);
  const sourceId = await source(batchId, current, options.source);
  return { current, batchId, sourceId };
}

async function investment(accountId, options = {}) {
  const label = tag();
  const { rows } = await pool.query(
    `INSERT INTO investments(name,symbol,asset_class,currency,current_price)
     VALUES($1,$1,'stock','EUR',12) RETURNING id`,
    [label],
  );
  owned.investments.push(rows[0].id);
  await pool.query(
    `INSERT INTO portfolio_transactions(investment_id,type,date,units,amount,price_per_unit,
       fees,taxes,currency,account_id,source_record_hash)
     VALUES($1,'buy','2025-01-01',10,100,10,$2,0,'EUR',$3,$4)`,
    [rows[0].id, options.fees ?? 0, accountId, options.sourceHash ?? null],
  );
  return rows[0].id;
}

async function recordedFundingFee(accountId) {
  const batchId = await batch(accountId, {
    format: "kinesis_transaction_history",
    status: "awaiting_review",
  });
  const main = await cash(accountId, {
    amount: -100,
    isTransfer: true,
    transferSource: "brokerage",
  });
  const fee = await cash(accountId, {
    amount: -2,
    transferSource: "brokerage",
    sourceHash: main.source_record_hash,
    fingerprint: cashFeeFingerprint(main),
  });
  const values = {
    date: main.date,
    amount: main.amount,
    currency: main.currency,
    accountId,
    isTransfer: true,
    transferSource: "brokerage",
    transferPeerId: null,
  };
  const rawData = JSON.stringify({
    primaryRawData: "synthetic funding withdrawal and quoted fee",
    portfolioCashReceipt: {
      version: 1,
      proof: {
        kind: "closed_kinesis_cash",
        eventKind: "own_account_funding",
        groupKey: hash("synthetic closed chain"),
        eventKey: hash("synthetic funding event"),
        fileHash: hash("synthetic source file"),
        memberCount: 1,
        componentCount: 2,
      },
      values,
      after: main,
      feeValues: { ...values, amount: fee.amount, isTransfer: false },
      feeAfter: fee,
    },
  });
  await source(batchId, main, { type: null, rawData });
  return { main, fee, batchId };
}

async function historicalRate(date, value) {
  const { rows } = await pool.query(
    `INSERT INTO exchange_rates(currency_code,rate_date,rate_to_eur,is_latest)
     VALUES('USD',$1,$2,false) RETURNING id`,
    [date, value],
  );
  owned.rates.push(rows[0].id);
}

async function cleanup() {
  if (!pool) return;
  // Match existing Kinesis test teardown: the migrated receipt trigger rejects
  // deleting recorded source evidence, including disposable fixtures.
  if (owned.batches.length) {
    await pool.query(
      "ALTER TABLE portfolio_import_staging_rows DISABLE TRIGGER trg_portfolio_cash_receipt_immutable",
    );
    try {
      await pool.query(
        "DELETE FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
        [owned.batches],
      );
    } finally {
      await pool.query(
        "ALTER TABLE portfolio_import_staging_rows ENABLE TRIGGER trg_portfolio_cash_receipt_immutable",
      );
    }
  }
  await pool.query("DELETE FROM transactions WHERE id=ANY($1::int[])", [
    owned.transactions,
  ]);
  await pool.query(
    "DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::int[])",
    [owned.investments],
  );
  for (const [table, ids] of [
    ["investments", owned.investments],
    ["accounts", owned.accounts],
    ["recipients", owned.recipients],
    ["categories", owned.categories],
    ["exchange_rates", owned.rates],
  ])
    await pool.query(`DELETE FROM ${table} WHERE id=ANY($1::int[])`, [ids]);
  for (const ids of Object.values(owned)) ids.length = 0;
}

describe.skipIf(!hasTestDatabase())(
  "source-owned brokerage cash fee summary",
  () => {
    beforeAll(acquireDbSuiteLock, 180_000);
    afterEach(cleanup);
    afterAll(async () => {
      await cleanup();
      await releaseDbSuiteLock();
      await closePool();
      await closeTestPool();
    });

    it("returns explicit zero account costs without changing empty investment totals", async () => {
      await ownedFee(await account(), { amount: 0 });
      const result = await summary();
      expect(result.brokerageCashFees).toEqual({
        total: 0,
        gainAfterFees: result.totals.totalGainLoss,
        usedFallbackRate: false,
        byAccount: [],
      });
    });

    it("counts canonical fees once across source owners and leaves investment math unchanged", async () => {
      const a = await account();
      const b = await account();
      await investment(a, { fees: 2 });
      const before = await summary();
      const first = await ownedFee(a, { amount: -3 });
      const repeatBatch = await batch(a, {
        format: "nexo_transaction_history",
      });
      await source(repeatBatch, first.current);
      const duplicateBatch = await batch(a);
      await source(duplicateBatch, first.current, {
        status: "duplicate",
        committedId: null,
      });
      await ownedFee(b, {
        amount: -2,
        batch: { format: "saxo_transaction_history" },
      });

      const result = await summary();
      expect(result.totals).toEqual(before.totals);
      expect(result.summaries).toEqual(before.summaries);
      expect(result.byAccount).toEqual(before.byAccount);
      expect(result.totals.totalFees).toBe(2);
      expect(result.brokerageCashFees).toEqual({
        total: 5,
        gainAfterFees: before.totals.totalGainLoss - 5,
        usedFallbackRate: false,
        byAccount: expect.arrayContaining([
          { account_id: a, total: 3 },
          { account_id: b, total: 2 },
        ]),
      });
      expect(result.brokerageCashFees.byAccount).toHaveLength(2);
    });

    it("excludes transfers, anchors, stale or aborted owners, inactive rows and inline fee overlap", async () => {
      const a = await account();
      await ownedFee(a, { amount: -2 });
      await ownedFee(a, { amount: -11, isTransfer: true });
      await ownedFee(a, { amount: -12, balance: 100 });
      await ownedFee(a, {
        amount: -13,
        source: { sourceHash: hash("stale owner") },
      });
      await ownedFee(a, { amount: -14, batch: { status: "aborted" } });
      await ownedFee(a, { amount: -15, isActive: false });
      await ownedFee(a, { amount: -16, transferSource: "opening" });
      await ownedFee(a, { amount: -17, transferSource: "adjustment" });
      await ownedFee(a, { amount: -18, source: { status: "matched" } });
      await ownedFee(a, { amount: 18 });
      const overlap = await ownedFee(a, { amount: -19 });
      await investment(a, {
        fees: 19,
        sourceHash: overlap.current.source_record_hash,
      });
      // A negative brokerage expense without import ownership is not enough.
      await cash(a, { amount: -20 });
      const result = await summary();
      expect(result.brokerageCashFees.total).toBe(2);
      expect(result.brokerageCashFees.byAccount).toEqual([
        { account_id: a, total: 2 },
      ]);
      expect(result.totals.totalFees).toBe(19);
    });

    it("accepts only the separate Kinesis fee component and retains it after category and memo edits", async () => {
      const a = await account();
      const { fee } = await recordedFundingFee(a);
      const before = await summary();
      expect(before.brokerageCashFees).toEqual({
        total: 2,
        gainAfterFees: before.totals.totalGainLoss - 2,
        usedFallbackRate: false,
        byAccount: [{ account_id: a, total: 2 }],
      });
      const { rows } = await pool.query(
        "INSERT INTO categories(general,detail,is_active) VALUES('TEST',$1,true) RETURNING id",
        [tag()],
      );
      owned.categories.push(rows[0].id);
      await pool.query(
        "UPDATE transactions SET category_id=$1,memo='User clarified account fee' WHERE id=$2",
        [rows[0].id, fee.id],
      );
      expect((await summary()).brokerageCashFees).toEqual(
        before.brokerageCashFees,
      );
      await pool.query("UPDATE transactions SET amount=-3 WHERE id=$1", [
        fee.id,
      ]);
      expect((await summary()).brokerageCashFees.total).toBe(0);
    });

    it("converts native cash costs at their historical date and honors the report cutoff", async () => {
      const a = await account();
      await historicalRate("2025-01-04", 0.5);
      await historicalRate("2025-01-10", 0.8);
      await historicalRate("2025-02-01", 0.9);
      await ownedFee(a, { amount: -2, currency: "USD", date: "2025-01-05" });
      await ownedFee(a, { amount: -5, currency: "USD", date: "2025-01-10" });
      await ownedFee(a, { amount: -40, date: "2025-02-01" });

      const early = await summary("2025-01-09");
      expect(early.brokerageCashFees.total).toBe(1);
      expect(early.brokerageCashFees.usedFallbackRate).toBe(false);
      const january = await summary();
      expect(january.brokerageCashFees.total).toBe(5);
      expect(january.brokerageCashFees.usedFallbackRate).toBe(false);
      expect(january.brokerageCashFees.byAccount).toEqual([
        { account_id: a, total: 5 },
      ]);
      expect((await summary("2025-02-01")).brokerageCashFees.total).toBe(45);
    });

    it("excludes future dated fees from the default current summary", async () => {
      const a = await account();
      await ownedFee(a, { amount: -2 });
      await ownedFee(a, { amount: -99, date: "2999-01-01" });
      const result = await getPortfolioSummary("EUR");
      expect(result.brokerageCashFees.total).toBe(2);
    });
  },
);
