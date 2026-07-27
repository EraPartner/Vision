/**
 * Real-Postgres orchestration tests for transferReconciliationService (ADR-083).
 *
 * Why this suite is DB-backed rather than another mock choreography: every
 * behaviour worth pinning here lives in the interaction between SQL predicates
 * and JS control flow — the candidate self-join's window/currency/account rules,
 * the guarded UPDATEs that make auto-marking safe, the FK `ON DELETE SET NULL`
 * that strands a peer, the per-pair `transfer_dismissals` exclusion. Mocking the
 * pool would assert the query strings we wrote rather than the outcomes the
 * database actually produces, which is exactly how the existing suites came to
 * encode query ORDER instead of behaviour.
 *
 * Isolation strategy (per the setup/db.js contract, which permits a per-suite
 * wipe when transactions would hide the behaviour under test): a per-test delete
 * of the touched tables rather than a wrapping transaction. `reconcileTransfers`
 * opens its own `withTransaction`, and it reconciles the WHOLE corpus rather
 * than an import batch — so an outer transaction would both nest and, more
 * importantly, leave other tests' rows visible as candidates. Wiping keeps every
 * case reasoning about a corpus it fully controls, and leaves no state behind.
 *
 * The seed writes account_id directly with a NULL bank_account: the
 * `trg_transactions_account_sync` trigger only resolves/creates an account when
 * bank_account is non-blank, so this path is inert and account assignment stays
 * exactly as written.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool, hasTestDatabase } from '../setup/db.js';
import {
  reconcileTransfers,
  getTransferSuggestions,
  markTransfer,
  unmarkTransfer,
  backfillTransfersOnce,
} from '../../src/services/transferReconciliationService.js';
import { closePool } from '../../src/database/connection.js';

/** Fixed reference date — the suite asserts on ±windowDays, never on "today". */
const DAY0 = '2024-03-10';

/** @param {number} n */
const daysAfter = (n) => {
  const d = new Date(`${DAY0}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let recipientId;
const accountIds = {};

async function seedFixtures() {
  const pool = getTestPool();
  const rec = await pool.query(
    `INSERT INTO recipients (name, normalized_name) VALUES ('Transfer Fixture', 'transfer fixture')
     RETURNING id`,
  );
  recipientId = rec.rows[0].id;
  for (const name of ['Checking', 'Savings', 'Brokerage']) {
    const res = await pool.query(
      `INSERT INTO accounts (name, display_name) VALUES ($1, $1) RETURNING id`,
      [name],
    );
    accountIds[name] = res.rows[0].id;
  }
}

/**
 * Insert one transaction and return its id.
 * @param {{account:string, amount:number|string, date?:string, currency?:string,
 *          isActive?:boolean, isTransfer?:boolean, peerId?:number|null,
 *          source?:string|null}} spec
 */
async function insertTxn({
  account,
  amount,
  date = DAY0,
  currency = 'EUR',
  isActive = true,
  isTransfer = false,
  peerId = null,
  source = null,
}) {
  const pool = getTestPool();
  const { rows } = await pool.query(
    `INSERT INTO transactions
       (date, amount, currency, recipient_id, account_id, is_active, is_transfer,
        transfer_peer_id, transfer_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      date,
      amount,
      currency,
      recipientId,
      accountIds[account],
      isActive,
      isTransfer,
      peerId,
      source,
    ],
  );
  return rows[0].id;
}

/** Read back the transfer-relevant columns of one row. */
async function readTxn(id) {
  const { rows } = await getTestPool().query(
    `SELECT id, is_transfer, transfer_peer_id, transfer_source
       FROM transactions WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** Insert an equal-and-opposite pair one day apart on two different accounts. */
async function seedMatchablePair(amount = -125.5, date = DAY0) {
  const outId = await insertTxn({ account: 'Checking', amount, date });
  const inId = await insertTxn({
    account: 'Savings',
    amount: -amount,
    date: daysAfter(1),
  });
  return { outId, inId };
}

describe.skipIf(!hasTestDatabase())('services/transferReconciliationService (real DB)', () => {
  beforeAll(async () => {
    // Fail loudly rather than mysteriously if the app pool and the fixture pool
    // point at different databases — the seed would be invisible to the service
    // and every assertion below would fail for a reason that has nothing to do
    // with the code under test.
    expect(
      process.env.DATABASE_URL,
      'DATABASE_URL must equal TEST_DATABASE_URL for this suite (see scripts/with-test-db.sh)',
    ).toBe(process.env.TEST_DATABASE_URL);
  });

  afterEach(async () => {
    const pool = getTestPool();
    // Targeted DELETEs, deliberately NOT `TRUNCATE ... CASCADE`: the cascade off
    // `transactions` reaches a dozen unrelated tables (split_audit,
    // planned_transaction_tags, portfolio_import_staging_rows, ...) and costs
    // ~350ms per test in ACCESS EXCLUSIVE locks and file truncation, versus ~3ms
    // here at these row counts. Order follows the FKs: transactions before
    // accounts (ON DELETE RESTRICT); transfer_dismissals cascades off
    // transactions but is cleared explicitly so the intent is visible.
    await pool.query('DELETE FROM transfer_dismissals');
    await pool.query('DELETE FROM transactions');
    await pool.query('DELETE FROM accounts');
    await pool.query('DELETE FROM recipients');
    await pool.query(`DELETE FROM user_settings WHERE key = 'transfers_backfilled'`);
  });

  afterAll(async () => {
    await closeTestPool();
    await closePool();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Auto-pairing
  // ───────────────────────────────────────────────────────────────────────────
  describe('reconcileTransfers — auto-pairing', () => {
    it('pairs an unambiguous equal-and-opposite match across two accounts', async () => {
      await seedFixtures();
      const { outId, inId } = await seedMatchablePair();

      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 1 });

      const out = await readTxn(outId);
      const inn = await readTxn(inId);
      expect(out).toMatchObject({
        is_transfer: true,
        transfer_peer_id: inId,
        transfer_source: 'auto',
      });
      expect(inn).toMatchObject({
        is_transfer: true,
        transfer_peer_id: outId,
        transfer_source: 'auto',
      });
    });

    it('is idempotent — a second reconcile creates nothing and changes nothing', async () => {
      await seedFixtures();
      const { outId, inId } = await seedMatchablePair();
      await reconcileTransfers();
      const before = [await readTxn(outId), await readTxn(inId)];

      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 0 });

      expect([await readTxn(outId), await readTxn(inId)]).toEqual(before);
    });

    it('respects the ±windowDays bound on the date gap', async () => {
      await seedFixtures();
      const outId = await insertTxn({ account: 'Checking', amount: -40 });
      const inId = await insertTxn({
        account: 'Savings',
        amount: 40,
        date: daysAfter(5),
      });

      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 0 });
      expect((await readTxn(outId)).is_transfer).toBe(false);

      // The same rows pair once the window is widened past the gap.
      await expect(reconcileTransfers({ windowDays: 7 })).resolves.toEqual({
        pairsCreated: 1,
      });
      expect((await readTxn(inId)).transfer_peer_id).toBe(outId);
    });

    it('does not pair two legs sitting on the same account', async () => {
      await seedFixtures();
      const outId = await insertTxn({ account: 'Checking', amount: -60 });
      await insertTxn({ account: 'Checking', amount: 60, date: daysAfter(1) });

      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 0 });
      expect((await readTxn(outId)).is_transfer).toBe(false);
    });

    it('does not pair legs in different currencies', async () => {
      await seedFixtures();
      const outId = await insertTxn({ account: 'Checking', amount: -75, currency: 'EUR' });
      await insertTxn({
        account: 'Savings',
        amount: 75,
        currency: 'USD',
        date: daysAfter(1),
      });

      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 0 });
      expect((await readTxn(outId)).is_transfer).toBe(false);
    });

    it('ignores inactive rows', async () => {
      await seedFixtures();
      const outId = await insertTxn({ account: 'Checking', amount: -90 });
      await insertTxn({
        account: 'Savings',
        amount: 90,
        date: daysAfter(1),
        isActive: false,
      });

      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 0 });
      expect((await readTxn(outId)).is_transfer).toBe(false);
    });

    it('leaves an ambiguous match open instead of guessing', async () => {
      await seedFixtures();
      // One outflow, two identical candidate inflows on two different accounts:
      // mutually unambiguous fails, so nothing may be auto-marked.
      const outId = await insertTxn({ account: 'Checking', amount: -200 });
      const inA = await insertTxn({ account: 'Savings', amount: 200, date: daysAfter(1) });
      const inB = await insertTxn({ account: 'Brokerage', amount: 200, date: daysAfter(1) });

      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 0 });
      for (const id of [outId, inA, inB]) {
        expect((await readTxn(id)).is_transfer).toBe(false);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Release paths — the reconcile is a repair pass, not just a detector
  // ───────────────────────────────────────────────────────────────────────────
  describe('reconcileTransfers — release paths', () => {
    it('releases an auto pair whose legs no longer satisfy the match rule', async () => {
      await seedFixtures();
      const { outId, inId } = await seedMatchablePair();
      await reconcileTransfers();

      // Edit one leg's amount: the pair is no longer equal-and-opposite.
      await getTestPool().query('UPDATE transactions SET amount = $1 WHERE id = $2', [
        -999,
        outId,
      ]);

      await reconcileTransfers();

      for (const id of [outId, inId]) {
        expect(await readTxn(id)).toMatchObject({
          is_transfer: false,
          transfer_peer_id: null,
          transfer_source: null,
        });
      }
    });

    it('releases a leg stranded by its peer being deleted', async () => {
      await seedFixtures();
      const { outId, inId } = await seedMatchablePair();
      await reconcileTransfers();

      // The FK is ON DELETE SET NULL, so deleting the peer leaves a phantom
      // one-way transfer that only releaseOrphanedTransfers can clean up.
      await getTestPool().query('DELETE FROM transactions WHERE id = $1', [inId]);
      expect(await readTxn(outId)).toMatchObject({
        is_transfer: true,
        transfer_peer_id: null,
      });

      await reconcileTransfers();

      expect(await readTxn(outId)).toMatchObject({
        is_transfer: false,
        transfer_source: null,
      });
    });

    it('does not release system rows that are transfers with no peer', async () => {
      await seedFixtures();
      // Opening anchors / trade cash legs / adjustments are is_transfer=true with
      // a NULL peer but are NOT reconciler-owned pairs — they must survive.
      const openingId = await insertTxn({
        account: 'Checking',
        amount: 1000,
        isTransfer: true,
        source: 'opening',
      });
      const tradeId = await insertTxn({
        account: 'Brokerage',
        amount: -500,
        isTransfer: true,
        source: 'trade',
      });

      await reconcileTransfers();

      expect(await readTxn(openingId)).toMatchObject({
        is_transfer: true,
        transfer_source: 'opening',
      });
      expect(await readTxn(tradeId)).toMatchObject({
        is_transfer: true,
        transfer_source: 'trade',
      });
    });

    it('never overwrites a manual mark', async () => {
      await seedFixtures();
      const { outId, inId } = await seedMatchablePair();
      await markTransfer(outId, inId);

      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 0 });

      expect(await readTxn(outId)).toMatchObject({
        is_transfer: true,
        transfer_peer_id: inId,
        transfer_source: 'manual',
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suggestions
  // ───────────────────────────────────────────────────────────────────────────
  describe('getTransferSuggestions', () => {
    it('returns the contended outflow with all of its candidate inflows', async () => {
      await seedFixtures();
      const outId = await insertTxn({ account: 'Checking', amount: -200 });
      const inA = await insertTxn({ account: 'Savings', amount: 200, date: daysAfter(1) });
      const inB = await insertTxn({ account: 'Brokerage', amount: 200, date: daysAfter(1) });

      const suggestions = await getTransferSuggestions();

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].outflow.id).toBe(outId);
      expect(suggestions[0].candidates.map((c) => c.id).sort((a, b) => a - b)).toEqual(
        [inA, inB].sort((a, b) => a - b),
      );
    });

    it('returns nothing when every match is unambiguous', async () => {
      await seedFixtures();
      await seedMatchablePair();
      await expect(getTransferSuggestions()).resolves.toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Manual marking
  // ───────────────────────────────────────────────────────────────────────────
  describe('markTransfer', () => {
    it('marks a cross-currency pair that auto-detection would reject', async () => {
      await seedFixtures();
      const aId = await insertTxn({ account: 'Checking', amount: -100, currency: 'EUR' });
      const bId = await insertTxn({ account: 'Savings', amount: 108.4, currency: 'USD' });

      await expect(markTransfer(aId, bId)).resolves.toEqual({ ok: true });

      expect(await readTxn(aId)).toMatchObject({
        is_transfer: true,
        transfer_peer_id: bId,
        transfer_source: 'manual',
      });
      expect(await readTxn(bId)).toMatchObject({
        is_transfer: true,
        transfer_peer_id: aId,
        transfer_source: 'manual',
      });
    });

    it('releases a prior peer instead of stranding it as a one-way transfer', async () => {
      await seedFixtures();
      // A auto-pairs with C, then the user manually re-pairs A with B.
      const { outId: aId, inId: cId } = await seedMatchablePair();
      await reconcileTransfers();
      const bId = await insertTxn({ account: 'Brokerage', amount: 125.5, date: daysAfter(1) });

      await markTransfer(aId, bId);

      expect(await readTxn(aId)).toMatchObject({
        transfer_peer_id: bId,
        transfer_source: 'manual',
      });
      // C goes back to open — NOT dismissed — so it stays matchable.
      expect(await readTxn(cId)).toMatchObject({
        is_transfer: false,
        transfer_peer_id: null,
        transfer_source: null,
      });
    });

    it('rejects two legs on the same account', async () => {
      await seedFixtures();
      const aId = await insertTxn({ account: 'Checking', amount: -30 });
      const bId = await insertTxn({ account: 'Checking', amount: 30 });
      await expect(markTransfer(aId, bId)).rejects.toThrow(/two different accounts/i);
      expect((await readTxn(aId)).is_transfer).toBe(false);
    });

    it('rejects two legs with the same sign', async () => {
      await seedFixtures();
      const aId = await insertTxn({ account: 'Checking', amount: -30 });
      const bId = await insertTxn({ account: 'Savings', amount: -30 });
      await expect(markTransfer(aId, bId)).rejects.toThrow(/opposite signs/i);
      expect((await readTxn(aId)).is_transfer).toBe(false);
    });

    it('rejects an inactive leg', async () => {
      await seedFixtures();
      const aId = await insertTxn({ account: 'Checking', amount: -30 });
      const bId = await insertTxn({ account: 'Savings', amount: 30, isActive: false });
      await expect(markTransfer(aId, bId)).rejects.toThrow(/must be active/i);
      expect((await readTxn(aId)).is_transfer).toBe(false);
    });

    it('rejects a missing leg', async () => {
      await seedFixtures();
      const aId = await insertTxn({ account: 'Checking', amount: -30 });
      await expect(markTransfer(aId, aId + 100_000)).rejects.toThrow(/must exist/i);
      expect((await readTxn(aId)).is_transfer).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Un-marking: the dismissal must be sticky AND scoped to the pair
  // ───────────────────────────────────────────────────────────────────────────
  describe('unmarkTransfer', () => {
    it('resets both legs and records the rejected pairing', async () => {
      await seedFixtures();
      const { outId, inId } = await seedMatchablePair();
      await reconcileTransfers();

      await expect(unmarkTransfer(outId)).resolves.toEqual({ ok: true });

      for (const id of [outId, inId]) {
        expect(await readTxn(id)).toMatchObject({
          is_transfer: false,
          transfer_peer_id: null,
          transfer_source: null,
        });
      }
      const { rows } = await getTestPool().query(
        'SELECT txn_a_id, txn_b_id FROM transfer_dismissals',
      );
      expect(rows).toEqual([
        { txn_a_id: Math.min(outId, inId), txn_b_id: Math.max(outId, inId) },
      ]);
    });

    it('keeps the dismissed pair from being re-paired by the next reconcile', async () => {
      await seedFixtures();
      const { outId, inId } = await seedMatchablePair();
      await reconcileTransfers();
      await unmarkTransfer(outId);

      // Without the per-pair dismissal, the rows are open again and this
      // reconcile would immediately restore the pairing the user just rejected.
      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 0 });
      expect((await readTxn(outId)).is_transfer).toBe(false);
      expect((await readTxn(inId)).is_transfer).toBe(false);
    });

    it('dismisses the PAIR, not the rows — a dismissed leg still pairs elsewhere', async () => {
      await seedFixtures();
      const { outId, inId } = await seedMatchablePair();
      await reconcileTransfers();
      await unmarkTransfer(outId);

      // The true counterpart arrives later on a third account. A↔B is dismissed,
      // but A must still be able to pair with C.
      const cId = await insertTxn({
        account: 'Brokerage',
        amount: 125.5,
        date: daysAfter(2),
      });
      // Remove B from the pool so A↔C is the only unambiguous match.
      await getTestPool().query('UPDATE transactions SET is_active = false WHERE id = $1', [
        inId,
      ]);

      await expect(reconcileTransfers()).resolves.toEqual({ pairsCreated: 1 });
      expect(await readTxn(outId)).toMatchObject({
        transfer_peer_id: cId,
        transfer_source: 'auto',
      });
    });

    it('still allows a manual mark of a dismissed pair', async () => {
      await seedFixtures();
      const { outId, inId } = await seedMatchablePair();
      await reconcileTransfers();
      await unmarkTransfer(outId);

      await expect(markTransfer(outId, inId)).resolves.toEqual({ ok: true });
      expect(await readTxn(outId)).toMatchObject({
        transfer_peer_id: inId,
        transfer_source: 'manual',
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // One-time backfill
  // ───────────────────────────────────────────────────────────────────────────
  describe('backfillTransfersOnce', () => {
    it('reconciles once and then short-circuits on the settings flag', async () => {
      await seedFixtures();
      await seedMatchablePair();

      await expect(backfillTransfersOnce()).resolves.toEqual({
        skipped: false,
        pairsCreated: 1,
      });

      const { rows } = await getTestPool().query(
        `SELECT 1 FROM user_settings WHERE key = 'transfers_backfilled'`,
      );
      expect(rows).toHaveLength(1);

      await expect(backfillTransfersOnce()).resolves.toEqual({ skipped: true });
    });
  });
});
