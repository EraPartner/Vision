/**
 * Real-Postgres end-to-end tests for a MULTI-CURRENCY Revolut import.
 *
 * ADR-089's addendum (decision D2, 2026-07-10) settled that a Revolut account
 * stays ONE `accounts` row holding several currencies, rather than being split
 * into `REVOLUT <CURRENCY>` accounts the way the Wise adapter splits. That makes
 * `bank_account` no longer a proxy for "one currency", and moves the whole
 * burden onto the row's own `transactions.currency`. The invariant the addendum
 * states is the one this suite pins: *a row's currency is always honored, never
 * collapsed into another currency's series.*
 *
 * Two independent things have to hold for that, and neither is visible to a
 * mock: the balance layer must anchor each currency on its OWN stamped rows,
 * and the import's duplicate identity must treat currency as part of a row's
 * identity. Both are decided by real NUMERIC comparisons, the real
 * per-currency lateral, and rows committed by an EARLIER transaction — so this
 * suite drives the actual pipeline against the actual schema and reads the
 * result back through the actual hub repository.
 *
 * Isolation: per-test targeted DELETEs of the corpus this suite owns. The
 * pipeline opens its own transactions, so a wrapping transaction would nest,
 * and the cross-batch case is specifically about what survives COMMIT.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';
import { createBatch, prepareImport, runImportPipeline, commitImport } from '../src/services/importPipeline/index.js';
import { accountRepository } from '../src/repositories/accountRepository.js';
import { closePool } from '../src/database/connection.js';

// Neither the MV refresh (this database has no materialized views) nor the
// planned-payment auto-link is what this suite measures; both are already
// try/caught inside the pipeline, so stubbing them keeps the assertions about
// the import itself. Transfer reconciliation is left REAL: it can deactivate
// rows, and "the USD row survived" must mean survived everything.
vi.mock('../src/services/aggregationRefresh.js', () => ({
  refreshAggregations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/services/materializedViewService.js', () => ({
  scheduleRefresh: vi.fn(),
  refreshMaterializedViews: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/services/plannedMatchService.js', () => ({
  autoLinkTransactions: vi.fn().mockResolvedValue({ autoLinkedCount: 0 }),
}));

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

const HEADER = 'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance';

/**
 * A rolling Revolut export for ONE `REVOLUT CURRENT` account holding EUR and
 * USD. The figures are chosen so that a currency-blind reading is loudly wrong
 * rather than coincidentally right:
 *
 *   EUR: −25.00 (stamp 175.00), +50.00 (stamp 225.00), −5.00 (NO stamp)
 *   USD: −40.00 (stamp 260.00), dated BETWEEN the last EUR stamp and the
 *        unstamped EUR row
 *
 * Correct, per-currency:  EUR = 225.00 − 5.00 = 220.00 ; USD = 260.00
 * Cross-currency collapse: the account's newest stamp is the USD 260.00, so it
 * would anchor everything and read 260.00 − 5.00 = 255.00 — a EUR balance built
 * out of a USD statement figure. Every asserted number below separates those.
 */
const EXPORT_V1 = `${HEADER}
Card Payment,Current,2026-03-01 10:00:00,2026-03-01 10:00:00,Alpha Shop,-25.00,0.00,EUR,COMPLETED,175.00
Transfer,Current,2026-03-02 10:00:00,2026-03-02 10:00:00,Bruno Salary,50.00,0.00,EUR,COMPLETED,225.00
Card Payment,Current,2026-03-03 10:00:00,2026-03-03 10:00:00,Gamma Store,-40.00,0.00,USD,COMPLETED,260.00
Card Payment,Current,2026-03-04 10:00:00,2026-03-04 10:00:00,Delta Cafe,-5.00,0.00,EUR,COMPLETED,
`;

/**
 * The NEXT export from the same account — Revolut exports are rolling windows,
 * so it repeats every row of V1 and adds one: a −25.00 **USD** card payment at
 * Alpha Shop on 2026-03-01. That row is identical to V1's first row on every
 * field the field-based dup check reads except its currency, and the
 * differing-tx_hash exemption does not cover it (that exemption is scoped to
 * the CURRENT batch, and the EUR row it collides with was committed by an
 * earlier one). It is a real transaction and must land.
 */
const EXPORT_V2 = `${EXPORT_V1}Card Payment,Current,2026-03-01 10:00:00,2026-03-01 10:00:00,Alpha Shop,-25.00,0.00,USD,COMPLETED,275.00
`;

/** Single-currency corpus, for the "no currency column" default. */
const EXPORT_EUR_ONLY = `${HEADER}
Card Payment,Current,2026-03-01 10:00:00,2026-03-01 10:00:00,Alpha Shop,-25.00,0.00,EUR,COMPLETED,175.00
Transfer,Current,2026-03-02 10:00:00,2026-03-02 10:00:00,Bruno Salary,50.00,0.00,EUR,COMPLETED,225.00
`;

/** @type {string[]} temp CSVs to unlink in afterEach */
let tempFiles = [];

/**
 * @param {string} csv
 * @returns {string} path to a temp CSV holding it
 */
function writeCsv(csv) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'revolut-mc-')), 'revolut.csv');
  fs.writeFileSync(file, csv, 'utf-8');
  tempFiles.push(file);
  return file;
}

/**
 * Run the full pipeline over `csv` and commit it.
 *
 * A first-time Revolut export resolves every recipient as 'new', so
 * `runImportPipeline` parks the batch in 'awaiting_review' with its rows
 * already 'matched'. Committing from there is exactly what the review route
 * does once the user confirms (importRoutes.js), so this drives the same two
 * calls rather than pre-seeding recipients to force the auto-commit path.
 *
 * @param {string} csv
 * @returns {Promise<{ imported: number, duplicates: number }>}
 */
async function importExport(csv) {
  const result = await runImportPipeline({
    filePath: writeCsv(csv),
    adapterName: 'revolut',
    filename: 'revolut.csv',
    sizeBytes: csv.length,
  });
  if (!result.requiresReview) {
    return { imported: result.imported ?? 0, duplicates: result.duplicates ?? 0 };
  }
  const committed = await commitImport({ batchId: result.batchId });
  return { imported: committed.imported, duplicates: committed.duplicates };
}

/** Every active ledger row, in ledger order. */
async function ledger() {
  const { rows } = await pool.query(
    `SELECT to_char(t.date, 'YYYY-MM-DD') AS date, t.bank_account,
            t.amount::text AS amount, t.currency, t.balance::text AS balance
       FROM transactions t
      WHERE t.is_active = true
      ORDER BY t.date, t.currency, t.id`,
  );
  return rows;
}

/** The one Revolut account as the accounts hub serves it. */
async function hubAccount() {
  const accounts = await accountRepository.getAll({});
  const revolut = accounts.filter((a) => a.name === 'REVOLUT CURRENT');
  expect(revolut).toHaveLength(1); // D2: ONE account, not one per currency
  return revolut[0];
}

async function wipe() {
  await pool.query(`DELETE FROM transactions`);
  await pool.query(`DELETE FROM import_staging_rows`);
  await pool.query(`DELETE FROM import_batches`);
  await pool.query(`DELETE FROM recipients`);
  await pool.query(`DELETE FROM categories`);
  await pool.query(`DELETE FROM accounts`);
}

describeDb('Revolut multi-currency import (real DB)', () => {
  beforeAll(acquireDbSuiteLock, 180_000);

  beforeEach(async () => {
    tempFiles = [];
    await wipe();
  });

  afterEach(async () => {
    await wipe();
    for (const file of tempFiles) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it('stamps each row with its own Currency column and keeps them in one account', async () => {
    const { imported } = await importExport(EXPORT_V1);
    expect(imported).toBe(4);

    const rows = await ledger();
    // One account for all four rows (D2), each row carrying its OWN currency.
    expect(rows.map((r) => r.bank_account)).toEqual(Array(4).fill('REVOLUT CURRENT'));
    expect(rows.map((r) => `${r.date} ${r.amount} ${r.currency}`)).toEqual([
      '2026-03-01 -25.0000 EUR',
      '2026-03-02 50.0000 EUR',
      '2026-03-03 -40.0000 USD',
      '2026-03-04 -5.0000 EUR',
    ]);
    // The Balance column rides along per row, including the blank one —
    // transactions.balance emits at 4 dp since migration 0088 (NUMERIC(18,4)).
    expect(rows.map((r) => r.balance)).toEqual(['175.0000', '225.0000', '260.0000', null]);
  });

  it('anchors each currency on its own stamps — a USD statement figure never anchors EUR', async () => {
    await importExport(EXPORT_V1);
    const account = await hubAccount();

    // `reconcilable_balance` is the hub's NATIVE (unconverted) figure for the
    // partition the account's statement is a statement for — accounts.currency,
    // EUR here. It is the FX-free window onto the EUR partition.
    //
    // 225.00 (last EUR stamp) − 5.00 (the unstamped EUR row after it) = 220.00.
    // A cross-currency collapse anchors on the newest stamp of ANY currency —
    // the USD 260.00 — and reads 255.00. A USD stamp leaking into the EUR
    // anchor at all reads 260.00 or 255.00; neither is 220.00.
    expect(account.reconcilable_currency).toBe('EUR');
    expect(account.reconcilable_balance).toBe(220);

    // The USD partition anchors on its own stamp and is NOT reduced by the
    // later EUR row: computed_balance is the FX-converted sum of both
    // partitions, so it must exceed the EUR partition by a positive USD 260
    // (whatever today's rate). Under a collapse there is only one partition and
    // the total IS the (single) balance.
    expect(account.computed_balance).toBeGreaterThan(220);

    // Provenance stays account-level: the newest stamp of any currency.
    expect(account.anchor_date).toBe('2026-03-03');
  });

  it('keeps a foreign-currency row that collides with an earlier batch on every other field', async () => {
    // First export: the EUR −25.00 Alpha Shop row lands.
    const first = await importExport(EXPORT_V1);
    expect(first.imported).toBe(4);

    // Next rolling export repeats all four and adds the USD −25.00 Alpha Shop
    // row for the same day. The four repeats are genuine duplicates; the USD
    // row differs from the stored EUR one ONLY by currency and must survive.
    const second = await importExport(EXPORT_V2);
    expect(second).toEqual({ imported: 1, duplicates: 4 });

    const rows = await ledger();
    expect(rows).toHaveLength(5);
    const alphaDay = rows.filter((r) => r.date === '2026-03-01');
    expect(alphaDay.map((r) => `${r.amount} ${r.currency}`)).toEqual([
      '-25.0000 EUR',
      '-25.0000 USD',
    ]);

    // And the surviving row lands in the USD series, not the EUR one: the EUR
    // partition is unchanged at 220.00, while USD gained the −25.00.
    const account = await hubAccount();
    expect(account.reconcilable_currency).toBe('EUR');
    expect(account.reconcilable_balance).toBe(220);
  });

  it('re-importing the same export is still a no-op', async () => {
    // The narrower dup identity must not cost idempotency. (This path is
    // adjudicated by tx_hash — identical source rows hash identically — so it
    // guards the pipeline as a whole rather than the field check specifically;
    // the test below isolates the field check.)
    expect(await importExport(EXPORT_V1)).toEqual({ imported: 4, duplicates: 0 });
    expect(await importExport(EXPORT_V1)).toEqual({ imported: 0, duplicates: 4 });
    expect(await importExport(EXPORT_V1)).toEqual({ imported: 0, duplicates: 4 });
    expect(await ledger()).toHaveLength(4);
  });

  it('defaults a currency-less staging row to EUR on BOTH sides of the field check', async () => {
    // Not every adapter fills the column — `ParsedBankTransaction.currency` is
    // nullable, and commit defaults it to EUR because transactions.currency is
    // NOT NULL. Were the dup key read off the RAW staging value, such a row
    // could never match the 'EUR' row its own first import wrote, and every
    // re-import would duplicate the whole ledger.
    // EUR-only corpus: NULLing the staged currency below must then be a no-op
    // in meaning, since EUR is exactly what the default resolves to. (Doing it
    // to the mixed export would legitimately re-key the USD rows to EUR — a
    // different question.)
    expect(await importExport(EXPORT_EUR_ONLY)).toMatchObject({ imported: 2 });

    const batchId = await createBatch({ adapterName: 'revolut', filename: 'revolut.csv', sizeBytes: EXPORT_EUR_ONLY.length });
    await prepareImport({ batchId, filePath: writeCsv(EXPORT_EUR_ONLY), adapterName: 'revolut' });
    // Drop the staged currency (the no-currency-column adapter's state) AND the
    // hash, so the hash short-circuits cannot decide the verdict and the
    // field-based check — the thing under test — is the sole adjudicator.
    // Both columns are nullable; validate.js documents the hash-less row as the
    // "adapter kept no raw record" case.
    await pool.query(
      `UPDATE import_staging_rows SET currency = NULL, tx_hash = NULL WHERE batch_id = $1`,
      [batchId],
    );

    expect(await commitImport({ batchId })).toMatchObject({ imported: 0, duplicates: 2 });
    expect(await ledger()).toHaveLength(2);
  });

  it('trims a trailing-space staged currency so the dup key matches what VARCHAR(3) stores', async () => {
    // transactions.currency is VARCHAR(3), and Postgres silently drops
    // TRAILING spaces on assignment to varchar(n) — 'EUR ' stores as 'EUR'.
    // Were the dup key the raw staging value, the probe would key on 'EUR '
    // while the ledger holds 'EUR': every re-import of the same rolling export
    // would miss the dup check and duplicate the row, unbounded. Every shipped
    // adapter trims its cell, so this pins the pipeline-level guarantee that
    // holds even for one that forgets.
    const stage = async () => {
      const batchId = await createBatch({ adapterName: 'revolut', filename: 'revolut.csv', sizeBytes: EXPORT_EUR_ONLY.length });
      await prepareImport({ batchId, filePath: writeCsv(EXPORT_EUR_ONLY), adapterName: 'revolut' });
      // Untrimmed currency from a hypothetical sloppy adapter; hash dropped so
      // the field check is the sole adjudicator (as in the EUR-default test).
      await pool.query(
        `UPDATE import_staging_rows SET currency = 'EUR ', tx_hash = NULL WHERE batch_id = $1`,
        [batchId],
      );
      return commitImport({ batchId });
    };

    expect(await stage()).toMatchObject({ imported: 2, duplicates: 0 });
    expect(await stage()).toMatchObject({ imported: 0, duplicates: 2 });
    const rows = await ledger();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.currency).toBe('EUR');
  });
});
