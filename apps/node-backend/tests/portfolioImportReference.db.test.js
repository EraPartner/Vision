import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.js";
import { closePool } from "../src/database/connection.ts";
import { createBatch } from "../src/services/portfolioImportPipeline/stage.js";
import { validateBatch } from "../src/services/portfolioImportPipeline/validate.js";
import { matchBatch } from "../src/services/portfolioImportPipeline/matchInvestments.js";
import { stagePortfolioReferenceRows } from "../src/repositories/portfolioImportReferenceRepository.ts";
import { applyPortfolioImportReference } from "../src/services/portfolioImportReferenceService.js";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.js";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.js";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.js";
import {
  portfolioPerformanceXml,
  ppEvent,
} from "./fixtures/portfolioPerformanceSynthetic.js";

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;
const owned = { accounts: [], investments: [], batches: [] };
const hash = (value) => createHash("sha256").update(value).digest("hex");
let directory;
let counter = 0;
async function fixture() {
  const account = (
    await pool.query(
      "INSERT INTO accounts(name,type,currency) VALUES($1,'brokerage','EUR') RETURNING id",
      [`Reference synthetic account ${++counter}`],
    )
  ).rows[0].id;
  const investment = (
    await pool.query(
      "INSERT INTO investments(name,symbol,asset_class,currency,price_provider,price_provider_id) VALUES('Synthetic Ether holding','ETH-EUR','crypto','EUR','yahoo','ETH-EUR') RETURNING id",
    )
  ).rows[0].id;
  owned.accounts.push(account);
  owned.investments.push(investment);
  return { account, investment };
}
async function xml(events = [], name = `reference-${++counter}.xml`) {
  const path = join(directory, name);
  await writeFile(path, portfolioPerformanceXml({ events }), { mode: 0o600 });
  return path;
}
async function sourceBatch(
  fx,
  format = "kinesis_transaction_history",
  rows = [{}],
) {
  const id = await createBatch({
    adapterName: format,
    customConfig: { format, yield_basis_policy: "zero" },
    defaultAssetClass: "crypto",
    isBrokerage: true,
    accountId: fx.account,
  });
  owned.batches.push(id);
  for (const [index, row] of rows.entries()) {
    const raw = row.raw_data || `synthetic primary source ${id}:${index}`;
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,symbol_raw,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_transaction_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence,note,asset_transfer_details)
   VALUES($1,$2,'matched',$3,$4,$5::portfolio_txn_type,'portfolio','ETH',$6,$7,$8,$17,$18,$9,$10,$11,$12,$13,$14,1,1,$15,$16::jsonb)`,
      [
        id,
        index,
        row.tx_date || "2025-01-01",
        row.type_raw || "Gift",
        row.type || "gift",
        row.units || "1",
        row.price_per_unit ?? null,
        row.amount ?? "0",
        row.currency || "USD",
        fx.investment,
        raw,
        row.source_transaction_id || `reference-source:${id}:${index}`,
        hash(raw),
        row.dedup_fingerprint || hash(`fp:${id}:${index}`),
        row.note ?? "Asset transfer in; original cost basis unavailable",
        JSON.stringify(
          row.asset_transfer_details ??
            (row.type && row.type !== "gift"
              ? null
              : { direction: "in", basisStatus: "unresolved" }),
        ),
        row.fees ?? "0",
        row.taxes ?? "0",
      ],
    );
  }
  await pool.query(
    "UPDATE portfolio_import_batches SET status='awaiting_review',rows_total=$2 WHERE id=$1",
    [id, rows.length],
  );
  return id;
}
async function manual(
  fx,
  {
    type = "gift",
    date = "2025-01-01",
    units = "1",
    amount = "200",
    currency = "EUR",
    price = "200",
    note = "Original manual reference note",
  } = {},
) {
  return (
    await pool.query(
      "INSERT INTO portfolio_transactions(investment_id,type,date,units,amount,price_per_unit,currency,note) VALUES($1,$2::portfolio_txn_type,$3,$4,$5,$6,$7,$8) RETURNING id",
      [fx.investment, type, date, units, amount, price, currency, note],
    )
  ).rows[0].id;
}
async function cleanup() {
  await pool.query(
    "TRUNCATE portfolio_import_reconciliation_journal,portfolio_import_duplicate_repair_journal RESTART IDENTITY",
  );
  if (owned.investments.length)
    await pool.query(
      "DELETE FROM portfolio_transactions WHERE investment_id=ANY($1::integer[])",
      [owned.investments],
    );
  if (owned.batches.length)
    await pool.query(
      "DELETE FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
      [owned.batches],
    );
  if (owned.investments.length)
    await pool.query("DELETE FROM investments WHERE id=ANY($1::integer[])", [
      owned.investments,
    ]);
  if (owned.accounts.length)
    await pool.query("DELETE FROM accounts WHERE id=ANY($1::integer[])", [
      owned.accounts,
    ]);
  for (const list of Object.values(owned)) list.length = 0;
}

describeDb("secondary reference staging and reviewed atomic adoption", () => {
  beforeAll(async () => {
    await acquireDbSuiteLock();
    directory = await mkdtemp(join(tmpdir(), "vision-reference-test-"));
  }, 180000);
  afterEach(cleanup);
  afterAll(async () => {
    await closePool();
    await releaseDbSuiteLock();
    await closeTestPool();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it("blocks a shifted rounded Pro sale before XML, then adopts its source date and fee without adding a copy", async () => {
    const fx = await fixture();
    const acquisition = await manual(fx, {
      type: "buy",
      date: "2024-12-01",
      units: "10",
      amount: "10",
      price: "1",
    });
    await pool.query(
      "UPDATE portfolio_transactions SET account_id=$2 WHERE id=$1",
      [acquisition, fx.account],
    );
    const old = await manual(fx, {
      type: "sell",
      units: "10",
      amount: "20.0231",
      price: "2.00231",
      note: "Original rounded funding-date sale note",
    });
    await pool.query(
      "UPDATE portfolio_transactions SET fees=0.03 WHERE id=$1",
      [old],
    );
    const raw =
      "202,2025-01-14 12:00:00,ETH/EUR,sell,market,2.002,2.002,,10,10,0.04,EUR,completed,DB-ROUNDED-SELL";
    const id = await sourceBatch(fx, "nexo_pro_spot_history", [
      {
        type: "sell",
        type_raw: "Sell",
        tx_date: "2025-01-14",
        units: "10",
        amount: "20.02",
        price_per_unit: "2.002",
        fees: "0.04",
        currency: "EUR",
        note: "Completed synthetic Pro execution",
        raw_data: raw,
        source_transaction_id: "nexo-pro:spot:order:DB-ROUNDED-SELL",
      },
    ]);
    const unproven = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(unproven).toMatchObject({
      ready: false,
      summary: { insert: 0, adopt: 0, blocked: 1 },
    });
    expect(unproven.blockers[0]).toMatchObject({
      reason: "unproven_economics",
      candidateTransactionIds: [old],
    });
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: unproven.planFingerprint,
      }),
    ).rejects.toMatchObject({ details: { reason: "reconciliation_required" } });
    expect(
      (
        await pool.query(
          "SELECT fees,to_char(date,'YYYY-MM-DD') date FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ fees: "0.0300", date: "2025-01-01" });
    const result = await applyPortfolioImportReference({
      batchIds: [id],
      placeholderBasisPolicy: "zero",
      referencePath: await xml([
        ppEvent({
          type: "SELL",
          shares: "10",
          amount: "19.99",
          units: [{ type: "FEE", amount: { currency: "EUR", amount: "0.03" } }],
        }),
      ]),
    });
    expect(result.blockers).toEqual([]);
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
    expect(plan.actions[0]).toMatchObject({
      action: "adopt",
      existingTransactionId: old,
    });
    expect(plan.actions[0].corrections).toEqual(
      expect.arrayContaining(["date", "fees"]),
    );
    expect(
      await commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 1, repaired: 0, errors: 0 });
    expect(
      (
        await pool.query(
          "SELECT id,to_char(date,'YYYY-MM-DD') date,amount,price_per_unit,fees,currency,note,account_id,import_batch_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      id: old,
      date: "2025-01-14",
      amount: "20.0200",
      price_per_unit: "2.002000",
      fees: "0.0400",
      currency: "EUR",
      note: "Original rounded funding-date sale note",
      account_id: fx.account,
      import_batch_id: null,
    });
    expect(
      (
        await pool.query(
          "SELECT id FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
          [fx.investment],
        )
      ).rows.map((r) => r.id),
    ).toEqual([acquisition, old]);
    const receipt = (
      await pool.query(
        "SELECT transaction_id,before_data,after_data FROM portfolio_import_reconciliation_journal WHERE batch_id=$1 AND action='adopt'",
        [id],
      )
    ).rows[0];
    expect(Number(receipt.transaction_id)).toBe(old);
    expect(receipt.before_data).toMatchObject({
      date: "2025-01-01",
      amount: "20.0231",
      fees: "0.0300",
      note: "Original rounded funding-date sale note",
    });
    expect(receipt.after_data).toMatchObject({
      date: "2025-01-14",
      amount: "20.0200",
      fees: "0.0400",
      note: receipt.before_data.note,
    });
  });
  it("restores a preserve-existing Pro receipt before fresh XML-backed native USD adoption without inventing FX", async () => {
    const fx = await fixture();
    const acquisition = await manual(fx, {
      type: "buy",
      date: "2024-12-01",
      units: "1",
      amount: "10",
      price: "10",
    });
    await pool.query(
      "UPDATE portfolio_transactions SET account_id=$2 WHERE id=$1",
      [acquisition, fx.account],
    );
    const old = await manual(fx, {
      type: "sell",
      amount: "90",
      price: "90",
      note: "Original manually recorded sale annotation",
    });
    const raw =
      "201,2025-01-01 12:00:00,ETH/USD,sell,market,999,100,,1,1,1,USD,completed,DB-NATIVE-SELL";
    const source = {
      type: "sell",
      type_raw: "Sell",
      units: "1",
      amount: "100",
      price_per_unit: "100",
      fees: "1",
      currency: "USD",
      note: "Completed synthetic Pro execution",
      raw_data: raw,
      source_transaction_id: "nexo-pro:spot:order:DB-NATIVE-SELL",
      dedup_fingerprint: hash(raw),
    };
    const first = await sourceBatch(fx, "nexo_pro_spot_history", [source]);
    const initial = await previewPortfolioImportReconciliation({
      batchIds: [first],
      adoptPolicy: "preserve_existing",
    });
    expect(initial).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
    expect(
      await commitReviewedPortfolioImports({
        batchIds: [first],
        adoptPolicy: "preserve_existing",
        expectedPlanFingerprint: initial.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 1 });
    expect(
      (
        await pool.query(
          "SELECT currency,amount,fees,account_id,note FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      currency: "EUR",
      amount: "90.0000",
      fees: "0.0000",
      account_id: fx.account,
      note: "Original manually recorded sale annotation",
    });
    expect(
      await previewPortfolioImportReconciliation({
        batchIds: [first],
        adoptPolicy: "prefer_source",
      }),
    ).toMatchObject({ ready: true, summary: { settled: 1, adopt: 0 } });
    await rollbackBatch(first);
    expect(
      (
        await pool.query(
          "SELECT currency,amount,fees,account_id,note,dedup_fingerprint FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      currency: "EUR",
      amount: "90.0000",
      fees: "0.0000",
      account_id: null,
      note: "Original manually recorded sale annotation",
      dedup_fingerprint: null,
    });
    const fresh = await sourceBatch(fx, "nexo_pro_spot_history", [source]);
    expect(fresh).not.toBe(first);
    expect(
      (
        await applyPortfolioImportReference({
          batchIds: [fresh],
          placeholderBasisPolicy: "zero",
          referencePath: await xml([
            ppEvent({ type: "SELL", amount: "90", currency: "EUR" }),
          ]),
        })
      ).blockers,
    ).toEqual([]);
    const authoritative = await previewPortfolioImportReconciliation({
      batchIds: [fresh],
      adoptPolicy: "prefer_source",
    });
    expect(authoritative).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
    expect(authoritative.actions[0]).toMatchObject({
      existingTransactionId: old,
      source: { currency: "USD", fx_rate_to_eur: null },
    });
    expect(
      await commitReviewedPortfolioImports({
        batchIds: [fresh],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: authoritative.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 1, errors: 0 });
    expect(
      (
        await pool.query(
          "SELECT id,currency,amount,price_per_unit,fees,fx_rate_to_eur,note,account_id,import_batch_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      id: old,
      currency: "USD",
      amount: "100.0000",
      price_per_unit: "100.000000",
      fees: "1.0000",
      fx_rate_to_eur: null,
      note: "Original manually recorded sale annotation",
      account_id: fx.account,
      import_batch_id: null,
    });
    expect(
      (
        await pool.query(
          "SELECT id FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
          [fx.investment],
        )
      ).rows.map((r) => r.id),
    ).toEqual([acquisition, old]);
    const receipts = (
      await pool.query(
        "SELECT id,batch_id,transaction_id,action,policy,previous_entry_id,before_data,after_data FROM portfolio_import_reconciliation_journal WHERE transaction_id=$1 ORDER BY id",
        [old],
      )
    ).rows;
    expect(receipts.map((r) => r.action)).toEqual([
      "adopt",
      "restore",
      "adopt",
    ]);
    expect(Number(receipts[1].previous_entry_id)).toBe(Number(receipts[0].id));
    expect(receipts[1].after_data).toEqual(receipts[0].before_data);
    expect(receipts[2]).toMatchObject({
      policy: "prefer_source",
      before_data: {
        currency: "EUR",
        amount: "90.0000",
        note: "Original manually recorded sale annotation",
      },
      after_data: {
        currency: "USD",
        amount: "100.0000",
        fx_rate_to_eur: null,
        note: "Original manually recorded sale annotation",
      },
    });
  });
  it("changes staging only, deduplicates concurrent same reference, then adopts native basis and rolls back exact legacy", async () => {
    const fx = await fixture();
    const old = await manual(fx);
    const id = await sourceBatch(fx);
    const path = await xml([ppEvent({ amount: "200", currency: "USD" })]);
    const before = (
      await pool.query(
        "SELECT row_to_json(pt) snapshot FROM portfolio_transactions pt WHERE id=$1",
        [old],
      )
    ).rows[0].snapshot;
    const results = await Promise.all([
      applyPortfolioImportReference({
        batchIds: [id],
        referencePath: path,
        placeholderBasisPolicy: "zero",
      }),
      applyPortfolioImportReference({
        batchIds: [id],
        referencePath: path,
        placeholderBasisPolicy: "zero",
      }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      batch_ids: [id],
      matched_reference_rows: 1,
      source_corrections: 1,
      blockers: [],
      replacement_batches: [],
    });
    expect(
      (
        await pool.query(
          "SELECT row_to_json(pt) snapshot FROM portfolio_transactions pt WHERE id=$1",
          [old],
        )
      ).rows[0].snapshot,
    ).toEqual(before);
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan.ready).toBe(true);
    const outcome = await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(outcome).toMatchObject({ imported: 0, adopted: 1, repaired: 0 });
    expect(
      (
        await pool.query(
          "SELECT id,account_id,currency,amount,fx_rate_to_eur,note,import_batch_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toMatchObject({
      id: old,
      account_id: fx.account,
      currency: "USD",
      amount: "200.0000",
      fx_rate_to_eur: null,
      note: before.note,
      import_batch_id: null,
    });
    await rollbackBatch(id);
    const restored = (
      await pool.query(
        "SELECT type,currency,amount,account_id,note FROM portfolio_transactions WHERE id=$1",
        [old],
      )
    ).rows[0];
    expect(restored).toMatchObject({
      type: before.type,
      currency: before.currency,
      amount: Number(before.amount).toFixed(4),
      account_id: before.account_id,
      note: before.note,
    });
  });
  it("restores a unique unavailable zero legacy basis from literal native reference and rolls it back", async () => {
    const fx = await fixture();
    const old = await manual(fx, { amount: "0", price: "0" });
    const id = await sourceBatch(fx);
    await applyPortfolioImportReference({
      batchIds: [id],
      referencePath: await xml([ppEvent({ amount: "200", currency: "USD" })]),
      placeholderBasisPolicy: "zero",
    });
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan.ready).toBe(true);
    expect(
      await commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 1 });
    expect(
      (
        await pool.query(
          "SELECT currency,amount,fx_rate_to_eur FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toMatchObject({
      currency: "USD",
      amount: "200.0000",
      fx_rate_to_eur: null,
    });
    await rollbackBatch(id);
    expect(
      (
        await pool.query(
          "SELECT currency,amount,account_id,note FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toMatchObject({
      currency: "EUR",
      amount: "0.0000",
      account_id: null,
      note: "Original manual reference note",
    });
  });
  it("adopts only a literal zero yield into zero legacy economics and preserves its identity through rollback", async () => {
    const fx = await fixture();
    const old = await manual(fx, { amount: "0", price: "0" });
    const raw =
      "2025-01-01 00:00:00,SYNTHETIC,ETH,Holder's_Distribution,YIELD-SYNTHETIC,,,1,,1,0,ETH,20,USD,0,ETH,1,ETH";
    const columns = [
      "DateTime",
      "HIN",
      "Currency_Code",
      "Transaction_Type",
      "Transaction_ID",
      "Order_ID",
      "Currency_Pair",
      "Amount",
      "Trade_Price",
      "Total",
      "Fee",
      "Fee_Currency",
      "Trade_Value",
      "Trade_Value_Currency",
      "Starting_Balance",
      "Starting_Balance_Currency",
      "Closing_Balance",
      "Closing_Balance_Currency",
    ];
    const id = await sourceBatch(fx, "kinesis_transaction_history", [
      {
        raw_data: raw,
        source_transaction_id: "YIELD-SYNTHETIC:units",
        amount: "0",
        price_per_unit: "0",
        note: "Holder's Distribution units",
      },
    ]);
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET asset_transfer_details=NULL,asset_adjustment_details=$2::jsonb WHERE batch_id=$1",
      [id, JSON.stringify({ kind: "yield_acquisition", basisPolicy: "zero" })],
    );
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=custom_config || $2::jsonb WHERE id=$1",
      [id, JSON.stringify({ source_columns: columns })],
    );
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan.ready).toBe(true);
    expect(
      await commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).toMatchObject({ imported: 0, adopted: 1 });
    expect(
      (
        await pool.query(
          "SELECT id,currency,amount,fx_rate_to_eur,note FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toMatchObject({
      id: old,
      currency: "USD",
      amount: "0.0000",
      fx_rate_to_eur: null,
      note: "Original manual reference note",
    });
    await rollbackBatch(id);
    expect(
      (
        await pool.query(
          "SELECT id,currency,amount,account_id,note FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toMatchObject({
      id: old,
      currency: "EUR",
      amount: "0.0000",
      account_id: null,
      note: "Original manual reference note",
    });
  });
  it("persists coverage blockers, refuses commit and changed XML reuse, and detects account routing changes", async () => {
    const fx = await fixture();
    await manual(fx);
    const id = await sourceBatch(fx);
    const first = await xml([
      ppEvent({ amount: "200", currency: "USD" }),
      ppEvent({ id: "old-uncovered", date: "2025-01-02", shares: "2" }),
    ]);
    const result = await applyPortfolioImportReference({
      batchIds: [id],
      referencePath: first,
      placeholderBasisPolicy: "zero",
    });
    expect(result.blockers.map((x) => x.reason)).toContain(
      "reference_unmatched_event",
    );
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan.ready).toBe(false);
    expect(plan.blockers.map((x) => x.reason)).toContain(
      "reference_unmatched_event",
    );
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toThrow();
    const changed = await xml([ppEvent({ amount: "201", currency: "USD" })]);
    await expect(
      applyPortfolioImportReference({
        batchIds: [id],
        referencePath: changed,
        placeholderBasisPolicy: "zero",
      }),
    ).rejects.toMatchObject({
      details: { reason: "reference_requires_restaging" },
    });
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=custom_config||'{\"transfer_destination_account_id\":999}'::jsonb WHERE id=$1",
      [id],
    );
    await expect(
      applyPortfolioImportReference({
        batchIds: [id],
        referencePath: first,
        placeholderBasisPolicy: "zero",
      }),
    ).rejects.toMatchObject({ details: { reason: "reference_scope_changed" } });
  });
  it("creates a normal validated managed review from retained terminal IBKR, including a previously errored row, without rewriting original source", async () => {
    const fx = await fixture();
    const id = await createBatch({
      adapterName: "ibkr_transaction_history",
      customConfig: { format: "ibkr_transaction_history" },
      defaultAssetClass: "crypto",
      isBrokerage: true,
      accountId: fx.account,
    });
    owned.batches.push(id);
    const rawRows = [
      {
        tx_date: "2025-01-01",
        type_raw: "Buy",
        type: "buy",
        route: "portfolio",
        symbol_raw: "ETH",
        investment_id: fx.investment,
        units: "5",
        price_per_unit: "100",
        amount: "500",
        fees: "0",
        taxes: "0",
        currency: "EUR",
        raw_data: "synthetic retained IBKR buy",
        source_transaction_id: "IBKR:synthetic:buy",
      },
      {
        tx_date: "2025-01-02",
        type_raw: "Sell",
        type: "sell",
        route: "portfolio",
        symbol_raw: "ETH",
        investment_id: fx.investment,
        units: "1",
        price_per_unit: "100",
        amount: "100",
        fees: "0",
        taxes: "0",
        currency: "EUR",
        raw_data: "synthetic retained IBKR sell",
        source_transaction_id: "IBKR:synthetic:sell",
      },
    ];
    await stagePortfolioReferenceRows(id, rawRows, { status: "pending" });
    await validateBatch({ batchId: id });
    await matchBatch({ batchId: id });
    const originalRows = (
      await pool.query(
        "SELECT * FROM portfolio_import_staging_rows WHERE batch_id=$1 ORDER BY row_index",
        [id],
      )
    ).rows;
    const imported = (
      await pool.query(
        `INSERT INTO portfolio_transactions(investment_id,type,date,units,price_per_unit,amount,currency,account_id,import_batch_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version) VALUES($1,'buy','2025-01-01',5,100,500,'EUR',$2,$3,$4,$5,1) RETURNING id`,
        [
          fx.investment,
          fx.account,
          id,
          originalRows[0].source_record_hash,
          originalRows[0].dedup_fingerprint,
        ],
      )
    ).rows[0].id;
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET status=CASE WHEN row_index=0 THEN 'committed' ELSE 'error' END,committed_txn_id=CASE WHEN row_index=0 THEN $2::integer ELSE NULL END,error_message=CASE WHEN row_index=1 THEN 'sell units exceed available holdings (synthetic)' ELSE NULL END WHERE batch_id=$1",
      [id, imported],
    );
    await pool.query(
      "UPDATE portfolio_import_batches SET status='complete_with_errors',rows_imported=1,rows_error=1 WHERE id=$1",
      [id],
    );
    const buy = await manual(fx, {
      type: "buy",
      units: "5",
      amount: "500",
      price: "100",
    });
    const sell = await manual(fx, {
      type: "sell",
      date: "2025-01-02",
      units: "1",
      amount: "100",
      price: "100",
    });
    const originalBefore = (
      await pool.query(
        "SELECT row_to_json(s) snapshot FROM portfolio_import_staging_rows s WHERE batch_id=$1 ORDER BY row_index",
        [id],
      )
    ).rows;
    const firstPath = await xml();
    const request = {
      batchIds: [id],
      referencePath: firstPath,
      placeholderBasisPolicy: "zero",
    };
    const first = await applyPortfolioImportReference(request);
    owned.batches.push(...first.batch_ids);
    expect(first.replacement_batches).toEqual([
      { original_batch_id: id, review_batch_id: first.batch_ids[0] },
    ]);
    expect(first.batch_ids).not.toContain(id);
    expect(first.supplemental_batches[0]).toMatchObject({
      adapter_name: "ibkr_transaction_history",
      rows_total: 2,
      status: "awaiting_review",
    });
    expect(
      (
        await pool.query(
          "SELECT row_to_json(s) snapshot FROM portfolio_import_staging_rows s WHERE batch_id=$1 ORDER BY row_index",
          [id],
        )
      ).rows,
    ).toEqual(originalBefore);
    expect(await applyPortfolioImportReference(request)).toEqual(first);
    const review = await previewPortfolioImportReconciliation({
      batchIds: first.batch_ids,
      adoptPolicy: "preserve_existing",
    });
    expect(review.ready).toBe(true);
    expect(review.summary).toMatchObject({ repair_duplicate: 1, adopt: 1 });
    const committed = await commitReviewedPortfolioImports({
      batchIds: first.batch_ids,
      adoptPolicy: "preserve_existing",
      expectedPlanFingerprint: review.planFingerprint,
    });
    expect(committed).toMatchObject({ imported: 0, adopted: 1, repaired: 1 });
    expect(
      await applyPortfolioImportReference({
        ...request,
        batchIds: first.batch_ids,
      }),
    ).toEqual(first);
    expect(
      (
        await pool.query(
          "SELECT id FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
          [fx.investment],
        )
      ).rows.map((x) => x.id),
    ).toEqual([buy, sell]);
    await rollbackBatch(first.batch_ids[0]);
    expect(
      (
        await pool.query(
          "SELECT id FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
          [fx.investment],
        )
      ).rows.map((x) => x.id),
    ).toEqual([imported, buy, sell]);
    const fresh = await sourceBatch(fx);
    const second = await applyPortfolioImportReference({
      batchIds: [id, fresh],
      referencePath: await xml([ppEvent({ amount: "200", currency: "USD" })]),
      placeholderBasisPolicy: "zero",
    });
    owned.batches.push(
      ...second.batch_ids.filter((x) => !owned.batches.includes(x)),
    );
    expect(second.replacement_batches[0].review_batch_id).not.toBe(
      first.batch_ids[0],
    );
  });
  it("rejects retained source tampering before creating a managed clone", async () => {
    const fx = await fixture();
    const id = await sourceBatch(fx, "ibkr_transaction_history", [
      {
        type: "buy",
        type_raw: "Buy",
        units: "1",
        amount: "200",
        price_per_unit: "200",
        currency: "EUR",
      },
    ]);
    await pool.query(
      "UPDATE portfolio_import_batches SET status='complete' WHERE id=$1",
      [id],
    );
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET raw_data='changed source' WHERE batch_id=$1",
      [id],
    );
    await expect(
      applyPortfolioImportReference({
        batchIds: [id],
        referencePath: await xml(),
        placeholderBasisPolicy: "zero",
      }),
    ).rejects.toMatchObject({
      details: { reason: "reference_retained_source_incomplete" },
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::integer n FROM portfolio_import_batches WHERE account_id=$1",
          [fx.account],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("invalidates reference cache and the main commit when investment resolution changes after enrichment", async () => {
    const fx = await fixture();
    const old = await manual(fx);
    const id = await sourceBatch(fx);
    const path = await xml([ppEvent({ amount: "200", currency: "USD" })]);
    await applyPortfolioImportReference({
      batchIds: [id],
      referencePath: path,
      placeholderBasisPolicy: "zero",
    });
    const other = (
      await pool.query(
        "INSERT INTO investments(name,symbol,asset_class,currency) VALUES('Synthetic Bitcoin','BTC','crypto','USD') RETURNING id",
      )
    ).rows[0].id;
    owned.investments.push(other);
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET user_override_investment_id=$2 WHERE batch_id=$1",
      [id, other],
    );
    await expect(
      applyPortfolioImportReference({
        batchIds: [id],
        referencePath: path,
        placeholderBasisPolicy: "zero",
      }),
    ).rejects.toMatchObject({ details: { reason: "reference_scope_changed" } });
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "preserve_existing",
    });
    expect(plan.ready).toBe(false);
    expect(plan.blockers.map((x) => x.reason)).toContain(
      "reference_scope_changed",
    );
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "preserve_existing",
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT account_id,currency FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ account_id: null, currency: "EUR" });
  });
});
