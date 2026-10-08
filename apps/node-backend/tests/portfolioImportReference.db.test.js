import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { createBatch } from "../src/services/portfolioImportPipeline/stage.ts";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.ts";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.ts";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.ts";
import { readReconciliationSources } from "../src/repositories/portfolioImportReconciliationRepository.ts";
import { toDecimal } from "../src/lib/money.ts";
import {
  retainedEvent,
  retainedReference,
  retainedEvidenceRow,
  retainedReferenceConfiguration,
} from "./fixtures/retainedPortfolioEvidence.ts";
import { capturedKinesisStatement } from "./helpers/kinesisSourceContext.ts";
import {
  assignImportIdentities,
  portfolioIdentityBase,
} from "../src/services/importIdentity.ts";

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;
const owned = { accounts: [], investments: [], batches: [], rates: [] };
const hash = (value) => createHash("sha256").update(value).digest("hex");
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
async function storedEvidence(batchId, event) {
  const rows = await readReconciliationSources([batchId]);
  const row = rows[0];
  const reference = retainedReference([event]);
  const facts =
    row.type === "gift"
      ? {
          amount: event.amount,
          price_per_unit: toDecimal(event.amount).div(row.units).toFixed(6),
          currency: event.currency,
          fx_rate_to_eur: undefined,
          asset_transfer_details: {
            ...row.asset_transfer_details,
            basisStatus: "recorded_reference",
          },
        }
      : {};
  const after = retainedEvidenceRow(
    row,
    reference,
    event,
    row.type === "gift" ? "recorded_native" : "primary_execution",
    facts,
  );
  await pool.query(
    "UPDATE portfolio_import_staging_rows SET raw_data=$2,amount=$3,price_per_unit=$4,currency=$5,fx_rate_to_eur=$6,asset_transfer_details=$7::jsonb WHERE id=$1",
    [
      row.id,
      after.raw_data,
      after.amount,
      after.price_per_unit,
      after.currency,
      after.fx_rate_to_eur ?? null,
      JSON.stringify(after.asset_transfer_details ?? null),
    ],
  );
  const current = await readReconciliationSources([batchId]);
  await pool.query(
    "UPDATE portfolio_import_batches SET custom_config=custom_config || $2::jsonb WHERE id=$1",
    [
      batchId,
      JSON.stringify({
        portfolio_performance_reference: retainedReferenceConfiguration(
          current,
          "full",
          reference,
        ),
      }),
    ],
  );
}
// One complete synthetic statement: an ETH asset deposit without original basis.
const KINESIS_ASSET_IN_ID = "TX-REFERENCE-ASSET-IN";
const KINESIS_ASSET_IN = `2025-01-01 12:00:00 UTC,KM00000001,ETH,Deposit,${KINESIS_ASSET_IN_ID},,,1,,,,,,,0,ETH,1,ETH`;
async function sourceBatch(
  fx,
  format = "kinesis_transaction_history",
  rows = format === "kinesis_transaction_history"
    ? [
        {
          raw_data: KINESIS_ASSET_IN,
          source_transaction_id: KINESIS_ASSET_IN_ID,
        },
      ]
    : [{}],
) {
  const kinesis = format === "kinesis_transaction_history";
  // Staging records the complete literal capture; full Kinesis review requires it.
  const captured = kinesis
    ? await capturedKinesisStatement([
        ...new Set(rows.map((row) => row.raw_data)),
      ])
    : undefined;
  const id = await createBatch({
    adapterName: format,
    customConfig: { format, yield_basis_policy: "zero", ...captured?.config },
    defaultAssetClass: "crypto",
    isBrokerage: true,
    accountId: fx.account,
  });
  owned.batches.push(id);
  for (const [index, row] of rows.entries()) {
    const raw = row.raw_data || `synthetic primary source ${id}:${index}`;
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,symbol_raw,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_transaction_id,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence,note,asset_transfer_details,source_account_identity)
   VALUES($1,$2,'matched',$3,$4,$5::portfolio_txn_type,'portfolio','ETH',$6,$7,$8,$17,$18,$9,$10,$11,$12,$13,$14,1,1,$15,$16::jsonb,$19)`,
      [
        id,
        index,
        row.tx_date || "2025-01-01",
        row.type_raw || "Gift",
        row.type || "gift",
        row.units === undefined ? "1" : row.units,
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
        kinesis
          ? (captured.parsed.find(
              (event) =>
                event.sourceId ===
                (row.source_transaction_id ||
                  `reference-source:${id}:${index}`),
            )?.sourceAccountIdentity ?? null)
          : null,
      ],
    );
  }
  if (kinesis) {
    // Staging assigns the source-identity fingerprints that Kinesis proofs recompute.
    const staged = await readReconciliationSources([id]);
    const identities = assignImportIdentities(staged, (row) =>
      portfolioIdentityBase(row, { accountIdentity: "UNASSIGNED" }),
    );
    for (const [index, row] of staged.entries())
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET dedup_fingerprint=$2,dedup_fingerprint_version=$3,dedup_occurrence=$4 WHERE id=$1",
        [
          row.id,
          identities[index].fingerprint,
          identities[index].version,
          identities[index].occurrence,
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
    "TRUNCATE portfolio_import_reconciliation_journal,portfolio_import_duplicate_repair_journal,portfolio_import_income_recognition_journal RESTART IDENTITY",
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
  if (owned.rates.length)
    await pool.query("DELETE FROM exchange_rates WHERE id=ANY($1::integer[])", [
      owned.rates,
    ]);
  for (const list of Object.values(owned)) list.length = 0;
}

describeDb("retained JSON evidence and reviewed atomic adoption", () => {
  beforeAll(acquireDbSuiteLock, 180000);
  afterEach(cleanup);
  afterAll(async () => {
    await closePool();
    await releaseDbSuiteLock();
    await closeTestPool();
  });
  it("blocks a shifted rounded Pro sale without retained proof, then adopts its source date and fee without adding a copy", async () => {
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
    await storedEvidence(
      id,
      retainedEvent({
        type: "SELL",
        shares: "10",
        amount: "19.99",
        units: [{ type: "FEE", amount: { currency: "EUR", amount: "0.03" } }],
      }),
    );
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
  it("restores a preserve-existing Pro receipt before fresh retained-proof native USD adoption without inventing FX", async () => {
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
    await storedEvidence(
      fresh,
      retainedEvent({ type: "SELL", amount: "90", currency: "EUR" }),
    );
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
  it("reads retained native basis, adopts once and rolls back exact legacy", async () => {
    const fx = await fixture();
    const old = await manual(fx);
    const id = await sourceBatch(fx);
    const before = (
      await pool.query(
        "SELECT row_to_json(pt) snapshot FROM portfolio_transactions pt WHERE id=$1",
        [old],
      )
    ).rows[0].snapshot;
    await storedEvidence(id, retainedEvent({ amount: "200", currency: "USD" }));
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
  it("restores a unique unavailable zero legacy basis from retained literal native basis and rolls it back", async () => {
    const fx = await fixture();
    const old = await manual(fx, { amount: "0", price: "0" });
    const id = await sourceBatch(fx);
    await storedEvidence(id, retainedEvent({ amount: "200", currency: "USD" }));
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
    // The complete statement record stages as its literal income and units events.
    const id = await sourceBatch(fx, "kinesis_transaction_history", [
      {
        raw_data: raw,
        type_raw: "Dividend",
        type: "dividend",
        source_transaction_id: "YIELD-SYNTHETIC:income",
        units: null,
        amount: "20",
        price_per_unit: null,
        note: "Holder's Distribution",
      },
      {
        raw_data: raw,
        source_transaction_id: "YIELD-SYNTHETIC:units",
        amount: "0",
        price_per_unit: "0",
        note: "Holder's Distribution units",
      },
    ]);
    // Paired income needs a stored historical rate; never fetch one in tests.
    const rate = await pool.query(
      "INSERT INTO exchange_rates(currency_code,rate_to_eur,rate_date,is_latest) VALUES('USD',0.9,'2025-01-01',false) ON CONFLICT(currency_code,rate_date) DO NOTHING RETURNING id",
    );
    owned.rates.push(...rate.rows.map((row) => row.id));
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET asset_transfer_details=NULL,asset_adjustment_details=$2::jsonb WHERE batch_id=$1 AND source_transaction_id=$3",
      [
        id,
        JSON.stringify({ kind: "yield_acquisition", basisPolicy: "zero" }),
        "YIELD-SYNTHETIC:units",
      ],
    );
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan.ready).toBe(true);
    // A complete literal statement adopts the zero legacy receipt with its own zero
    // economics and records the paired literal income instead of a second acquisition.
    expect(plan.summary).toMatchObject({
      insert: 0,
      adopt: 1,
      record_income: 1,
    });
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "adopt",
          existingTransactionId: old,
          corrections: [],
        }),
        expect.objectContaining({
          action: "record_income",
          incomeProof: expect.objectContaining({ unitTransactionId: old }),
        }),
      ]),
    );
    expect(
      await commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).toMatchObject({ imported: 1, recordedIncome: 1, adopted: 1 });
    expect(
      (
        await pool.query(
          "SELECT id,type,currency,amount,fx_rate_to_eur,note,account_id,import_batch_id,income_recognition_role FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
          [fx.investment],
        )
      ).rows,
    ).toMatchObject([
      {
        id: old,
        type: "gift",
        currency: "EUR",
        amount: "0.0000",
        fx_rate_to_eur: null,
        note: "Original manual reference note",
        account_id: fx.account,
        import_batch_id: null,
      },
      {
        type: "dividend",
        currency: "USD",
        amount: "20.0000",
        income_recognition_role: "included_in_units",
      },
    ]);
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
    expect(
      (
        await pool.query(
          "SELECT id FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
          [fx.investment],
        )
      ).rows.map((row) => row.id),
    ).toEqual([old]);
  });
});
