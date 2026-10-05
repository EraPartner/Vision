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
import { closePool } from "../src/database/connection.js";
import { previewPortfolioImportReconciliation } from "../src/services/portfolioImportReconciliationService.js";
import { commitReviewedPortfolioImports } from "../src/services/portfolioImportCommitService.js";
import { rollbackBatch } from "../src/services/portfolioImportBatchService.js";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.js";
import { pruneOldImportBatches } from "../src/startup/warmup.js";

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;
const owned = { accounts: [], investments: [], batches: [] };
const hash = (value) => createHash("sha256").update(value).digest("hex");
let sequence = 0;

async function fixture() {
  const account = (
    await pool.query(
      "INSERT INTO accounts(name,type,currency) VALUES ($1,'brokerage','EUR') RETURNING id",
      [`Reconciliation test broker ${++sequence}`],
    )
  ).rows[0].id;
  const investment = (
    await pool.query(
      "INSERT INTO investments(name,symbol,asset_class,currency) VALUES ('Reconciliation test asset','RECONTEST','stock','EUR') RETURNING id",
    )
  ).rows[0].id;
  owned.accounts.push(account);
  owned.investments.push(investment);
  return { account, investment };
}
async function legacy(
  fx,
  {
    date = "2026-01-01",
    amount = 500,
    units = 5,
    price = 100,
    fees = 0,
    note = "Original manual note",
  } = {},
) {
  return (
    await pool.query(
      `INSERT INTO portfolio_transactions(investment_id,type,date,amount,units,price_per_unit,fees,currency,note)
    VALUES ($1,'buy',$2,$3,$4,$5,$6,'EUR',$7) RETURNING id`,
      [fx.investment, date, amount, units, price, fees, note],
    )
  ).rows[0].id;
}
async function batch(
  fx,
  rows = [{}],
  { identityPrefix = `receipt-${++sequence}` } = {},
) {
  const id = Number(
    (
      await pool.query(
        `INSERT INTO portfolio_import_batches(adapter_name,custom_config,status,rows_total,account_id,is_brokerage)
    VALUES ('saxo_transaction_history','{"format":"saxo_transaction_history"}','awaiting_review',$1,$2,true) RETURNING id`,
        [rows.length, fx.account],
      )
    ).rows[0].id,
  );
  owned.batches.push(id);
  for (const [index, row] of rows.entries()) {
    const identity = `${identityPrefix}-${index}`;
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
      VALUES ($1,$2,$3,$4,$5::text,$5::text::portfolio_txn_type,'portfolio',$6,$7,$8,$9,0,'EUR',$10,$11,$12,$13,1,1)`,
      [
        id,
        index,
        row.status ?? "matched",
        row.date ?? "2026-01-01",
        row.type ?? "buy",
        row.units === undefined ? 5 : row.units,
        row.price === undefined ? 100 : row.price,
        row.amount ?? 500,
        row.fees ?? 0,
        fx.investment,
        `Synthetic source ${identity}`,
        hash(`raw-${identity}`),
        hash(identity),
      ],
    );
  }
  return id;
}
async function cleanup() {
  // Suite-wide advisory lock makes these receipts solely this fixture corpus.
  await pool.query(
    "TRUNCATE portfolio_import_reconciliation_journal RESTART IDENTITY",
  );
  await pool.query(
    "TRUNCATE portfolio_import_duplicate_repair_journal RESTART IDENTITY",
  );
  if (owned.investments.length)
    await pool.query(
      "DELETE FROM portfolio_asset_transfers WHERE investment_id = ANY($1::integer[])",
      [owned.investments],
    );
  if (owned.investments.length)
    await pool.query(
      "DELETE FROM portfolio_transactions WHERE investment_id = ANY($1::integer[])",
      [owned.investments],
    );
  if (owned.batches.length)
    await pool.query(
      "DELETE FROM portfolio_import_batches WHERE id = ANY($1::bigint[])",
      [owned.batches],
    );
  if (owned.investments.length)
    await pool.query("DELETE FROM investments WHERE id = ANY($1::integer[])", [
      owned.investments,
    ]);
  if (owned.accounts.length)
    await pool.query("DELETE FROM accounts WHERE id = ANY($1::integer[])", [
      owned.accounts,
    ]);
  owned.accounts.length = 0;
  owned.investments.length = 0;
  owned.batches.length = 0;
}

describeDb("real PostgreSQL reversible source adoption", () => {
  beforeAll(acquireDbSuiteLock, 180000);
  afterEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("adopts a base-fee execution whose literal amount PostgreSQL rounds at an exact half", async () => {
    const fx = await fixture();
    const old = await legacy(fx, { amount: 20, units: 10, price: 2 });
    const id = await batch(fx, [
      { units: "9.999925", price: 2, amount: "19.99985", fees: "0.00015" },
    ]);
    await pool.query(
      `UPDATE portfolio_import_batches SET adapter_name='nexo_pro_spot_history',
        custom_config='{"format":"nexo_pro_spot_history"}' WHERE id=$1`,
      [id],
    );
    await pool.query(
      `UPDATE portfolio_import_staging_rows SET symbol_raw='SYN',
        source_transaction_id='nexo-pro:spot:order:PRO-HALF-DECIMAL',raw_data=$2
        WHERE batch_id=$1`,
      [
        id,
        "203,2026-01-01 12:00:00,SYN/EUR,buy,limit,2,2,,10,10,0.000075,SYN,completed,PRO-HALF-DECIMAL",
      ],
    );
    const preview = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(preview).toMatchObject({
      ready: true,
      summary: { adopt: 1, insert: 0 },
    });
    expect(preview.actions[0].existingTransactionId).toBe(old);
    const result = await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
      expectedPlanFingerprint: preview.planFingerprint,
    });
    expect(result).toMatchObject({ adopted: 1, imported: 0, errors: 0 });
    const saved = (
      await pool.query(
        "SELECT id,amount,units,fees FROM portfolio_transactions WHERE investment_id=$1",
        [fx.investment],
      )
    ).rows;
    expect(saved).toEqual([
      { id: old, amount: "19.9999", units: "9.99992500", fees: "0.0002" },
    ]);
  });

  it.each(["dividend", "interest"])(
    "corrects gross %s and withholding from a proven net manual amount",
    async (type) => {
      const fx = await fixture();
      const old = (
        await pool.query(
          `INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,note,dividend_amount_convention)
      VALUES($1,$2::portfolio_txn_type,'2026-01-01',85,'EUR','Original income note',$3) RETURNING id`,
          [fx.investment, type, type === "dividend" ? "net" : "unknown"],
        )
      ).rows[0].id;
      const id = await batch(fx, [
        { type, amount: 100, units: null, price: null },
      ]);
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET taxes=15 WHERE batch_id=$1",
        [id],
      );
      const plan = await previewPortfolioImportReconciliation({
        batchIds: [id],
        adoptPolicy: "prefer_source",
      });
      expect(plan.ready).toBe(true);
      expect(plan.actions[0].economicsProven).toBe(true);
      await commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
        expectedPlanFingerprint: plan.planFingerprint,
      });
      expect(
        (
          await pool.query(
            "SELECT amount,taxes,dividend_amount_convention FROM portfolio_transactions WHERE id=$1",
            [old],
          )
        ).rows[0],
      ).toEqual({
        amount: "100.0000",
        taxes: "15.0000",
        dividend_amount_convention: type === "dividend" ? "gross" : "unknown",
      });
      await rollbackBatch(id);
      expect(
        (
          await pool.query(
            "SELECT amount,taxes,dividend_amount_convention FROM portfolio_transactions WHERE id=$1",
            [old],
          )
        ).rows[0],
      ).toEqual({
        amount: "85.0000",
        taxes: "0.0000",
        dividend_amount_convention: type === "dividend" ? "net" : "unknown",
      });
    },
  );

  it("proves cross-currency net income only with the supplied source FX", async () => {
    const fx = await fixture();
    const old = (
      await pool.query(
        "INSERT INTO portfolio_transactions(investment_id,type,date,amount,currency,dividend_amount_convention) VALUES($1,'dividend','2026-01-01',68,'EUR','net') RETURNING id",
        [fx.investment],
      )
    ).rows[0].id;
    const id = await batch(fx, [
      { type: "dividend", amount: 100, units: null, price: null },
    ]);
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET taxes=15,currency='USD',fx_rate_to_eur=0.8 WHERE batch_id=$1",
      [id],
    );
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    expect(plan.ready).toBe(true);
    await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT amount,taxes,currency,fx_rate_to_eur FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      amount: "100.0000",
      taxes: "15.0000",
      currency: "USD",
      fx_rate_to_eur: "0.8000000000",
    });
    await rollbackBatch(id);
    expect(
      (
        await pool.query(
          "SELECT amount,currency,dividend_amount_convention FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({
      amount: "68.0000",
      currency: "EUR",
      dividend_amount_convention: "net",
    });
  });

  it.each(["close", "type"])(
    "rechecks account eligibility after waiting for a concurrent %s",
    async (change) => {
      const fx = await fixture();
      const id = await batch(fx);
      const writer = await pool.connect();
      let pending;
      try {
        await writer.query("BEGIN");
        await writer.query(
          change === "close"
            ? "UPDATE accounts SET is_active=false WHERE id=$1"
            : "UPDATE accounts SET type='checking' WHERE id=$1",
          [fx.account],
        );
        pending = commitReviewedPortfolioImports({ batchIds: [id] }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          waiting =
            (
              await pool.query(
                "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT id FROM accounts WHERE id = ANY%'",
              )
            ).rows.length > 0;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        await writer.query("COMMIT");
        expect(await pending).toMatchObject({
          error: {
            status: 400,
            message: expect.stringContaining("active portfolio account"),
          },
        });
        expect(
          (
            await pool.query(
              "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
              [fx.investment],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await pool.query(
              "SELECT status FROM portfolio_import_batches WHERE id=$1",
              [id],
            )
          ).rows[0].status,
        ).toBe("awaiting_review");
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
        if (pending) await pending;
      }
    },
  );

  it("keeps the original ID, notes and units, journals adoption, and restores them on rollback", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx);
    const before = (
      await pool.query(
        "SELECT to_jsonb(pt) - 'updated_at' AS row FROM portfolio_transactions pt WHERE id=$1",
        [old],
      )
    ).rows[0].row;
    const result = await commitReviewedPortfolioImports({ batchIds: [id] });
    expect(result).toMatchObject({
      imported: 0,
      adopted: 1,
      duplicates: 1,
      errors: 0,
    });
    const current = (
      await pool.query("SELECT * FROM portfolio_transactions WHERE id=$1", [
        old,
      ])
    ).rows[0];
    expect(current.account_id).toBe(fx.account);
    expect(current.note).toBe("Original manual note");
    expect(current.import_batch_id).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [id],
        )
      ).rows[0].committed_txn_id,
    ).toBeNull();
    await expect(rollbackBatch(id)).resolves.toMatchObject({ deleted: 0 });
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt) - 'updated_at' AS row FROM portfolio_transactions pt WHERE id=$1",
          [old],
        )
      ).rows[0].row,
    ).toEqual(before);
    expect(
      (
        await pool.query(
          "SELECT action FROM portfolio_import_reconciliation_journal ORDER BY id",
        )
      ).rows.map((row) => row.action),
    ).toEqual(["adopt", "restore"]);
  });

  it("requires a reviewed source policy, applies date/fee correction, and restores the original", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx, [{ date: "2026-01-03", fees: 2 }]);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [id] }),
    ).rejects.toMatchObject({ details: { reason: "reconciliation_required" } });
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "prefer_source",
    });
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "prefer_source",
      }),
    ).rejects.toThrow("expected_plan_fingerprint");
    await commitReviewedPortfolioImports({
      batchIds: [id],
      adoptPolicy: "prefer_source",
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT fees, to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ fees: "2.0000", date: "2026-01-03" });
    await rollbackBatch(id);
    expect(
      (
        await pool.query(
          "SELECT fees, to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0],
    ).toEqual({ fees: "0.0000", date: "2026-01-01" });
  });

  it("commits a reviewed mixed source policy and rejects stale or unreviewed overrides", async () => {
    const preserved = await fixture();
    const corrected = await fixture();
    const oldPreserved = await legacy(preserved);
    const oldCorrected = await legacy(corrected);
    const one = await batch(preserved, [{ date: "2026-01-03", fees: 2 }]);
    const two = await batch(corrected, [{ date: "2026-01-03", fees: 2 }]);
    const batchPolicies = [{ batchId: one, adoptPolicy: "preserve_existing" }];
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [two, one],
      adoptPolicy: "prefer_source",
      batchPolicies,
    });
    expect(plan).toMatchObject({ ready: true, batchPolicies });
    await expect(
      commitReviewedPortfolioImports({ batchIds: [one, two], batchPolicies }),
    ).rejects.toThrow("expected_plan_fingerprint");
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [one, two],
        adoptPolicy: "prefer_source",
        batchPolicies: [],
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toMatchObject({
      details: { reason: "stale_reconciliation_plan" },
    });
    await commitReviewedPortfolioImports({
      batchIds: [one, two],
      adoptPolicy: "prefer_source",
      batchPolicies,
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT fees,to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [oldPreserved],
        )
      ).rows[0],
    ).toEqual({ fees: "0.0000", date: "2026-01-01" });
    expect(
      (
        await pool.query(
          "SELECT fees,to_char(date,'YYYY-MM-DD') AS date FROM portfolio_transactions WHERE id=$1",
          [oldCorrected],
        )
      ).rows[0],
    ).toEqual({ fees: "2.0000", date: "2026-01-03" });
    await rollbackBatch(one);
    await rollbackBatch(two);
  });

  it("rejects stale plans and preserves all state", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx);
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [id],
      adoptPolicy: "preserve_existing",
    });
    await pool.query(
      "UPDATE portfolio_transactions SET note='Concurrent manual edit' WHERE id=$1",
      [old],
    );
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        adoptPolicy: "preserve_existing",
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).rejects.toMatchObject({
      details: { reason: "stale_reconciliation_plan" },
    });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("refuses rollback after an adopted transaction was edited, including deleting new rows", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx, [
      {},
      { date: "2026-02-01", units: 2, amount: 200 },
    ]);
    await commitReviewedPortfolioImports({ batchIds: [id] });
    await pool.query(
      "UPDATE portfolio_transactions SET note='User edit after import' WHERE id=$1",
      [old],
    );
    await expect(rollbackBatch(id)).rejects.toMatchObject({
      details: { reason: "adopted_transaction_changed" },
    });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT status FROM portfolio_import_batches WHERE id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("complete");
  });

  it("dedups duplicate source exports globally before one adoption", async () => {
    const fx = await fixture();
    await legacy(fx);
    const one = await batch(fx, [{}], { identityPrefix: "same-export" });
    const two = await batch(fx, [{}], { identityPrefix: "same-export" });
    const result = await commitReviewedPortfolioImports({
      batchIds: [two, one],
    });
    expect(result).toMatchObject({ adopted: 1, imported: 0, duplicates: 2 });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("blocks partial unsupported input and rolls back another batch's valid changes", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const one = await batch(fx);
    const two = await batch(fx, [{ status: "error", date: "2026-02-01" }]);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [one, two] }),
    ).rejects.toMatchObject({ details: { reason: "incomplete_source" } });
    expect(
      (
        await pool.query(
          "SELECT account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0].account_id,
    ).toBeNull();
  });

  it("commits older funding buys before a sell from an earlier-selected batch", async () => {
    const fx = await fixture();
    const sell = await batch(fx, [
      { type: "sell", date: "2026-01-03", units: 4, amount: 400 },
    ]);
    const buy = await batch(fx);
    await expect(
      commitReviewedPortfolioImports({ batchIds: [sell, buy] }),
    ).resolves.toMatchObject({ imported: 2, errors: 0 });
    const history = (
      await pool.query(
        "SELECT type FROM portfolio_transactions WHERE investment_id=$1 ORDER BY id",
        [fx.investment],
      )
    ).rows;
    expect(history.map((row) => row.type)).toEqual(["buy", "sell"]);
  });

  it("rolls back adopted rows, receipts and prior sibling inserts after a runtime failure", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const id = await batch(fx, [
      {},
      { date: "2026-02-01", units: 2, amount: 200 },
      { date: "2026-03-01", units: 3, amount: 300 },
    ]);
    const original = portfolioTransactionService.create;
    let writes = 0;
    const spy = vi
      .spyOn(portfolioTransactionService, "create")
      .mockImplementation(async (...args) => {
        if (++writes === 2) throw new Error("Synthetic row write failure");
        return original(...args);
      });
    try {
      await expect(
        commitReviewedPortfolioImports({ batchIds: [id] }),
      ).rejects.toMatchObject({ details: { reason: "atomic_import_failed" } });
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await pool.query(
          "SELECT account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0].account_id,
    ).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_reconciliation_journal",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT status FROM portfolio_import_batches WHERE id=$1",
          [id],
        )
      ).rows[0].status,
    ).toBe("awaiting_review");
    expect(
      (
        await pool.query(
          "SELECT status FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [id],
        )
      ).rows.every((row) => row.status === "matched"),
    ).toBe(true);
  });

  it("atomically adopts the original acquisition and carries its dated custody without extra units", async () => {
    const fx = await fixture();
    const old = await legacy(fx);
    const destination = (
      await pool.query(
        "INSERT INTO accounts(name,type,currency) VALUES ('Reconciliation custody','brokerage','EUR') RETURNING id",
      )
    ).rows[0].id;
    owned.accounts.push(destination);
    const id = await batch(fx);
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=custom_config || jsonb_build_object('transfer_destination_account_id',$2::integer),rows_total=2 WHERE id=$1",
      [id, destination],
    );
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,units,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_transfer_details)
      VALUES ($1,1,'matched','2026-01-05','AssetTransfer','asset_transfer',5,0,0,0,'EUR',$2,'Synthetic custody transfer',$3,$4,1,'{"direction":"out","basisStatus":"carried","feeUnits":"0","receivedUnits":"5"}')`,
      [id, fx.investment, hash(`transfer-raw-${id}`), hash(`transfer-${id}`)],
    );
    const preview = await previewPortfolioImportReconciliation({
      batchIds: [id],
    });
    expect(preview).toMatchObject({
      ready: true,
      summary: { adopt: 1, transfer: 1 },
    });
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [id],
        expectedPlanFingerprint: preview.planFingerprint,
      }),
    ).resolves.toMatchObject({ adopted: 1, imported: 1 });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT source_account_id,destination_account_id,units FROM portfolio_asset_transfers WHERE import_batch_id=$1",
          [id],
        )
      ).rows[0],
    ).toMatchObject({
      source_account_id: fx.account,
      destination_account_id: destination,
      units: "5.00000000",
    });
    expect(
      (
        await pool.query(
          "SELECT committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1 AND route='asset_transfer'",
          [id],
        )
      ).rows[0].committed_txn_id,
    ).toBeNull();
    await expect(rollbackBatch(id)).resolves.toMatchObject({ deleted: 1 });
    expect(
      (
        await pool.query(
          "SELECT account_id FROM portfolio_transactions WHERE id=$1",
          [old],
        )
      ).rows[0].account_id,
    ).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_asset_transfers WHERE import_batch_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("requires Pro companion history and retains same-account Wallet movements without canonical transactions", async () => {
    const fx = await fixture();
    const wallet = await batch(fx, []);
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=$2::jsonb,rows_total=1 WHERE id=$1",
      [wallet, JSON.stringify({ format: "nexo_transaction_history" })],
    );
    await pool.query(
      `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,route,units,amount,fees,taxes,currency,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,asset_transfer_details)
      VALUES ($1,0,'matched','2026-01-02','InternalMovement','account_internal',5,0,0,0,'EUR','Synthetic Wallet Pro movement',$2,$3,1,'{"direction":"internal","basisStatus":"not_applicable"}')`,
      [wallet, hash(`wallet-raw-${wallet}`), hash(`wallet-${wallet}`)],
    );
    expect(
      (await previewPortfolioImportReconciliation({ batchIds: [wallet] }))
        .blockers[0].reason,
    ).toBe("missing_companion_pro_history");
    const pro = await batch(fx);
    await pool.query(
      "UPDATE portfolio_import_batches SET custom_config=$2::jsonb WHERE id=$1",
      [pro, JSON.stringify({ format: "nexo_pro_spot_history" })],
    );
    const plan = await previewPortfolioImportReconciliation({
      batchIds: [wallet, pro],
    });
    expect(plan).toMatchObject({
      ready: true,
      summary: { internal_annotation: 1, insert: 1 },
    });
    await expect(
      commitReviewedPortfolioImports({
        batchIds: [wallet, pro],
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).resolves.toMatchObject({ imported: 1, duplicates: 1, errors: 0 });
    expect(
      (
        await pool.query(
          "SELECT status,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [wallet],
        )
      ).rows[0],
    ).toEqual({ status: "duplicate", committed_txn_id: null });
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_transactions WHERE investment_id=$1",
          [fx.investment],
        )
      ).rows[0].n,
    ).toBe(1);
    await expect(rollbackBatch(wallet)).resolves.toMatchObject({ deleted: 0 });
  });

  it("makes receipts immutable and keeps their source batch/provenance", async () => {
    const fx = await fixture();
    await legacy(fx);
    const id = await batch(fx);
    await commitReviewedPortfolioImports({ batchIds: [id] });
    await expect(
      pool.query(
        "UPDATE portfolio_import_reconciliation_journal SET policy='prefer_source'",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      pool.query(`INSERT INTO portfolio_import_reconciliation_journal(batch_id,staging_row_id,transaction_id,action,policy,before_data,after_data,previous_entry_id)
      SELECT batch_id,staging_row_id,transaction_id,'restore',policy,after_data,'{}',id FROM portfolio_import_reconciliation_journal WHERE action='adopt'`),
    ).rejects.toThrow("Invalid portfolio import restoration receipt");
    await expect(
      pool.query("DELETE FROM portfolio_import_batches WHERE id=$1", [id]),
    ).rejects.toThrow(/violates.*foreign key constraint/);
  });

  async function duplicatedHistory({ count = 1 } = {}) {
    const fx = await fixture();
    const rows = Array.from({ length: count }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    }));
    const identityPrefix = `duplicate-repair-${++sequence}`;
    const originalBatch = await batch(fx, rows, { identityPrefix });
    await commitReviewedPortfolioImports({ batchIds: [originalBatch] });
    const imported = (
      await pool.query(
        "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE import_batch_id=$1 ORDER BY date,id",
        [originalBatch],
      )
    ).rows.map((row) => row.data);
    const legacyIds = [];
    for (const row of rows)
      legacyIds.push(await legacy(fx, { ...row, fees: 2 }));
    const reviewBatch = await batch(fx, rows, { identityPrefix });
    return { fx, originalBatch, reviewBatch, imported, legacyIds };
  }

  it("requires explicit reviewed duplicate repair and restores full original rows, pointers and counters", async () => {
    const data = await duplicatedHistory();
    await pool.query(
      "UPDATE portfolio_import_batches SET started_at=NOW()-INTERVAL '60 days' WHERE id=ANY($1::bigint[])",
      [[data.originalBatch, data.reviewBatch]],
    );
    const absent = await previewPortfolioImportReconciliation({
      batchIds: [data.reviewBatch],
    });
    expect(absent.blockers[0].reason).toBe("duplicate_repair_policy_required");
    const scope = {
      batchIds: [data.reviewBatch],
      adoptPolicy: "prefer_source",
    };
    const plan = await previewPortfolioImportReconciliation(scope);
    expect(plan).toMatchObject({
      ready: true,
      summary: { repair_duplicate: 1 },
    });
    expect(plan.actions[0]).toMatchObject({
      action: "repair_duplicate",
      existingTransactionId: data.legacyIds[0],
      importedTransactionId: data.imported[0].id,
      originalBatchId: data.originalBatch,
    });
    await expect(
      commitReviewedPortfolioImports({
        ...scope,
        expectedPlanFingerprint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      commitReviewedPortfolioImports({
        ...scope,
        expectedPlanFingerprint: plan.planFingerprint,
      }),
    ).resolves.toMatchObject({
      repaired: 1,
      adopted: 0,
      imported: 0,
      duplicates: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT id,note,fees,import_batch_id FROM portfolio_transactions WHERE investment_id=$1",
          [data.fx.investment],
        )
      ).rows,
    ).toEqual([
      {
        id: data.legacyIds[0],
        note: "Original manual note",
        fees: "0.0000",
        import_batch_id: null,
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT status,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ status: "duplicate", committed_txn_id: null });
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 0, rows_duplicate: 1 });
    await expect(
      pool.query(
        "UPDATE portfolio_import_duplicate_repair_journal SET policy='preserve_existing'",
      ),
    ).rejects.toThrow("immutable");
    await expect(
      pool.query("DELETE FROM portfolio_import_batches WHERE id=$1", [
        data.originalBatch,
      ]),
    ).rejects.toThrow(/foreign key constraint/);
    await pruneOldImportBatches();
    expect(
      (
        await pool.query(
          "SELECT COUNT(*)::integer AS n FROM portfolio_import_batches WHERE id=ANY($1::bigint[])",
          [[data.originalBatch, data.reviewBatch]],
        )
      ).rows[0].n,
    ).toBe(2);
    await expect(rollbackBatch(data.reviewBatch)).resolves.toMatchObject({
      deleted: 0,
      restored: 1,
      restored_imported: 1,
    });
    expect(
      (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE id=$1",
          [data.imported[0].id],
        )
      ).rows[0].data,
    ).toEqual(data.imported[0]);
    expect(
      (
        await pool.query(
          "SELECT account_id,fees,note FROM portfolio_transactions WHERE id=$1",
          [data.legacyIds[0]],
        )
      ).rows[0],
    ).toEqual({
      account_id: null,
      fees: "2.0000",
      note: "Original manual note",
    });
    expect(
      (
        await pool.query(
          "SELECT status,committed_txn_id FROM portfolio_import_staging_rows WHERE batch_id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ status: "committed", committed_txn_id: data.imported[0].id });
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 1, rows_duplicate: 0 });
    expect(
      (
        await pool.query(
          "SELECT action FROM portfolio_import_duplicate_repair_journal ORDER BY id",
        )
      ).rows.map((row) => row.action),
    ).toEqual(["repair", "restore"]);
  });

  it("restores several repairs from one old batch in reverse receipt order", async () => {
    const data = await duplicatedHistory({ count: 2 });
    // Separate dates must have a unique counterpart within the overlap window.
    await pool.query(
      "UPDATE portfolio_transactions SET units=6,amount=600 WHERE id=ANY($1::integer[])",
      [[data.legacyIds[1], data.imported[1].id]],
    );
    await pool.query(
      "UPDATE portfolio_import_staging_rows SET units=6,amount=600 WHERE batch_id=ANY($1::bigint[]) AND row_index=1",
      [[data.originalBatch, data.reviewBatch]],
    );
    const scope = {
      batchIds: [data.reviewBatch],
      adoptPolicy: "preserve_existing",
    };
    const plan = await previewPortfolioImportReconciliation(scope);
    expect(plan.ready).toBe(true);
    await commitReviewedPortfolioImports({
      ...scope,
      expectedPlanFingerprint: plan.planFingerprint,
    });
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 0, rows_duplicate: 2 });
    await expect(rollbackBatch(data.reviewBatch)).resolves.toMatchObject({
      restored: 2,
      restored_imported: 2,
    });
    expect(
      (
        await pool.query(
          "SELECT rows_imported,rows_duplicate FROM portfolio_import_batches WHERE id=$1",
          [data.originalBatch],
        )
      ).rows[0],
    ).toEqual({ rows_imported: 2, rows_duplicate: 0 });
  });

  it.each([
    ["missing provenance", "duplicate_repair_provenance_missing"],
    ["ambiguous legacy", "ambiguous_history"],
    ["changed economics", "duplicate_repair_imported_changed"],
    ["edited imported note", "duplicate_repair_imported_annotations_changed"],
    ["unproven foreign legacy", "unproven_currency_conversion"],
  ])(
    "blocks duplicate repair with %s and preserves both financial records",
    async (target, reason) => {
      const data = await duplicatedHistory();
      if (target === "missing provenance")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET committed_txn_id=NULL WHERE batch_id=$1",
          [data.originalBatch],
        );
      if (target === "ambiguous legacy") await legacy(data.fx);
      if (target === "changed economics")
        await pool.query(
          "UPDATE portfolio_transactions SET fees=3 WHERE id=$1",
          [data.imported[0].id],
        );
      if (target === "edited imported note")
        await pool.query(
          "UPDATE portfolio_transactions SET note='Meaningful imported annotation' WHERE id=$1",
          [data.imported[0].id],
        );
      if (target === "unproven foreign legacy")
        await pool.query(
          "UPDATE portfolio_transactions SET currency='USD' WHERE id=$1",
          [data.legacyIds[0]],
        );
      const scope = {
        batchIds: [data.reviewBatch],
        adoptPolicy: "prefer_source",
      };
      const before = (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
          [data.fx.investment],
        )
      ).rows;
      const plan = await previewPortfolioImportReconciliation(scope);
      expect(plan.ready).toBe(false);
      expect(plan.blockers[0].reason).toBe(reason);
      await expect(
        commitReviewedPortfolioImports({
          ...scope,
          expectedPlanFingerprint: plan.planFingerprint,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
            [data.fx.investment],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT COUNT(*)::integer AS n FROM portfolio_import_duplicate_repair_journal",
          )
        ).rows[0].n,
      ).toBe(0);
    },
  );

  it.each(["legacy", "staging", "batch", "recreated_imported"])(
    "blocks repair rollback after hostile %s changes without deleting a new row",
    async (target) => {
      const data = await duplicatedHistory();
      await pool.query(
        "UPDATE portfolio_transactions SET date='2025-01-01' WHERE id=$1",
        [data.imported[0].id],
      );
      await pool.query(
        "UPDATE portfolio_transactions SET date='2025-01-01' WHERE id=$1",
        [data.legacyIds[0]],
      );
      await pool.query(
        "UPDATE portfolio_import_staging_rows SET tx_date='2025-01-01' WHERE batch_id=ANY($1::bigint[])",
        [[data.originalBatch, data.reviewBatch]],
      );
      await pool.query(
        "UPDATE portfolio_import_batches SET rows_total=2 WHERE id=$1",
        [data.reviewBatch],
      );
      await pool.query(
        `INSERT INTO portfolio_import_staging_rows(batch_id,row_index,status,tx_date,type_raw,type,route,units,price_per_unit,amount,fees,taxes,currency,resolved_investment_id,raw_data,source_record_hash,dedup_fingerprint,dedup_fingerprint_version,dedup_occurrence)
      VALUES($1,1,'matched','2026-01-01','buy','buy','portfolio',1,100,100,0,0,'EUR',$2,'Synthetic genuinely new acquisition',$3,$4,1,1)`,
        [
          data.reviewBatch,
          data.fx.investment,
          hash(`hostile-newraw-${data.reviewBatch}`),
          hash(`hostile-new-${data.reviewBatch}`),
        ],
      );
      const scope = {
        batchIds: [data.reviewBatch],
        adoptPolicy: "preserve_existing",
      };
      const plan = await previewPortfolioImportReconciliation(scope);
      expect(plan.ready).toBe(true);
      await commitReviewedPortfolioImports({
        ...scope,
        expectedPlanFingerprint: plan.planFingerprint,
      });
      if (target === "legacy")
        await pool.query(
          "UPDATE portfolio_transactions SET note='Edited after repair' WHERE id=$1",
          [data.legacyIds[0]],
        );
      if (target === "staging")
        await pool.query(
          "UPDATE portfolio_import_staging_rows SET note='Edited provenance' WHERE batch_id=$1",
          [data.originalBatch],
        );
      if (target === "batch")
        await pool.query(
          "UPDATE portfolio_import_batches SET rows_duplicate=rows_duplicate+1 WHERE id=$1",
          [data.originalBatch],
        );
      if (target === "recreated_imported")
        await pool.query(
          "INSERT INTO portfolio_transactions(id,investment_id,type,date,amount,units,currency) VALUES($1,$2,'buy','2025-01-01',500,5,'EUR')",
          [data.imported[0].id, data.fx.investment],
        );
      const before = (
        await pool.query(
          "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
          [data.fx.investment],
        )
      ).rows;
      await expect(rollbackBatch(data.reviewBatch)).rejects.toMatchObject({
        status: 409,
        details: { reason: "duplicate_repair_changed" },
      });
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(pt) AS data FROM portfolio_transactions pt WHERE investment_id=$1 ORDER BY id",
            [data.fx.investment],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await pool.query(
            "SELECT status FROM portfolio_import_batches WHERE id=$1",
            [data.reviewBatch],
          )
        ).rows[0].status,
      ).toBe("complete");
    },
  );
});
