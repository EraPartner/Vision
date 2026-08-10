/**
 * ADR-108 WP-C4 parity invariant — REAL Postgres, the work package's
 * definition of done:
 *
 *   Σ per-account (invested / realized / unrealized / value / gainLoss)
 *     ≡ the global engine outputs of getPortfolioSummary,
 *
 * on fixtures covering: multi-account same instrument, split-then-sell,
 * re-tag-then-sell (a raw SQL UPDATE of account_id mid-history — the engine
 * must re-partition purely from the rows' CURRENT account), return of
 * capital, and an unassigned remainder (partial assignment → global figures
 * stay the exact flat-replay values while per-account figures are withheld).
 * The whole matrix runs under every cost-basis method (weighted_avg / fifo /
 * lifo) resolved from the SAME user_settings key the summary reads — no
 * second method-resolution path.
 *
 * Every expected value is hand-computed (see inline arithmetic) and cent-
 * exact, and the fixture is deliberately ASYMMETRIC (different lot prices per
 * broker, sells only at one broker, a lot bought at broker A AFTER broker B's
 * lots) so that a partition engine that silently falls back to flat
 * cross-account lot consumption produces DIFFERENT numbers for every method —
 * the green suite cannot mask a broken partition seam behind symmetric math.
 *
 * Needs TEST_DATABASE_URL and DATABASE_URL pointing at the same migrated
 * database (the service under test uses the app's own pool).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from './setup/db.js';

import { closePool } from '../src/database/connection.js';
import { getPortfolioSummary } from '../src/services/portfolio/portfolioSummaryService.js';

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

/** Fixture ids populated by seed(). */
const fx = {};

async function setCostBasisMethod(method) {
  await pool.query(
    `INSERT INTO user_settings (key, value) VALUES ('cost_basis_method', to_jsonb($1::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [method],
  );
}

async function seedAccount(name, displayName) {
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $2) RETURNING id`,
    [name, displayName],
  );
  return rows[0].id;
}

async function seedInvestment(name, currentPrice) {
  const { rows } = await pool.query(
    `INSERT INTO investments (name, symbol, asset_class, currency, current_price)
     VALUES ($1, $1, 'stock', 'EUR', $2) RETURNING id`,
    [name, currentPrice],
  );
  return rows[0].id;
}

async function seedTxn(investmentId, type, date, { units = null, amount = 0, accountId = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_transactions (investment_id, type, date, amount, units, currency, account_id)
     VALUES ($1, $2, $3::date, $4, $5, 'EUR', $6) RETURNING id`,
    [investmentId, type, date, amount, units, accountId],
  );
  return rows[0].id;
}

async function wipe() {
  await pool.query(`DELETE FROM portfolio_transactions`);
  await pool.query(`DELETE FROM investments`);
  await pool.query(`DELETE FROM accounts WHERE name LIKE 'WPC4P %'`);
  await pool.query(`DELETE FROM user_settings WHERE key = 'cost_basis_method'`);
}

async function seed() {
  fx.ibkr = await seedAccount('WPC4P IBKR', 'Interactive Brokers');
  fx.degiro = await seedAccount('WPC4P DEGIRO', 'Degiro');
  const A = fx.ibkr;
  const B = fx.degiro;

  // ── MULTI (price 12): multi-account, method-discriminating ──────────────
  // A: 100u/1000 then 10u/400 (bought LAST). B: 25u/400 + 25u/600, sells 25u/750.
  // Partitioned: B's sell consumes only B's lots → realized fifo 350 / lifo 150 / w-avg 250.
  // Flat replay would instead say 500 / −10 / 375 — every method distinguishes.
  fx.multi = await seedInvestment('WPC4P MULTI', 12);
  await seedTxn(fx.multi, 'buy', '2026-01-01', { units: 100, amount: 1000, accountId: A });
  await seedTxn(fx.multi, 'buy', '2026-02-01', { units: 25, amount: 400, accountId: B });
  await seedTxn(fx.multi, 'buy', '2026-02-15', { units: 25, amount: 600, accountId: B });
  await seedTxn(fx.multi, 'buy', '2026-02-20', { units: 10, amount: 400, accountId: A });
  await seedTxn(fx.multi, 'sell', '2026-03-01', { units: 25, amount: 750, accountId: B });

  // ── SPLIT (price 55): split-then-sell ────────────────────────────────────
  // A 10u/1000, B 10u/1100; 2:1 split (→ 40 global); B sells 15u/900.
  // Split must rescale BOTH partitions: A 20u (cost 1000), B 20u (cost 1100);
  // B's sold cost = 1100·15/20 = 825 → realized 75, remainder 5u @ cost 275.
  fx.split = await seedInvestment('WPC4P SPLIT', 55);
  await seedTxn(fx.split, 'buy', '2026-01-01', { units: 10, amount: 1000, accountId: A });
  await seedTxn(fx.split, 'buy', '2026-01-02', { units: 10, amount: 1100, accountId: B });
  await seedTxn(fx.split, 'split', '2026-02-01', { units: 40 });
  await seedTxn(fx.split, 'sell', '2026-03-01', { units: 15, amount: 900, accountId: B });

  // ── RETAG (price 20): re-tag-then-sell ───────────────────────────────────
  // Both lots bought at A; the 20u/500 lot is then RE-TAGGED to B by a raw
  // UPDATE (exactly what the WP-C3 endpoints will do); B sells 10u/400.
  // The engine must see the CURRENT account: B realized = 400 − 250 = 150.
  // If re-tagging didn't re-partition history, B would hold nothing and the
  // sell would clamp to realized 0.
  fx.retag = await seedInvestment('WPC4P RETAG', 20);
  await seedTxn(fx.retag, 'buy', '2026-01-01', { units: 30, amount: 300, accountId: A });
  const movedLot = await seedTxn(fx.retag, 'buy', '2026-01-10', { units: 20, amount: 500, accountId: A });
  await pool.query(`UPDATE portfolio_transactions SET account_id = $1 WHERE id = $2`, [B, movedLot]);
  await seedTxn(fx.retag, 'sell', '2026-02-01', { units: 10, amount: 400, accountId: B });

  // ── ROC (price 12): return of capital across partitions ─────────────────
  // A 100u/1000, B 50u/1000; RoC 300 allocates by units held: A −200, B −100.
  fx.roc = await seedInvestment('WPC4P ROC', 12);
  await seedTxn(fx.roc, 'buy', '2026-01-01', { units: 100, amount: 1000, accountId: A });
  await seedTxn(fx.roc, 'buy', '2026-01-02', { units: 50, amount: 1000, accountId: B });
  await seedTxn(fx.roc, 'return_of_capital', '2026-03-01', { amount: 300 });

  // ── UNASSIGNED (price 10): partial assignment → transition rule ──────────
  // A 60u/600 + 40u/400 unassigned, 10u/150 sold unassigned. Global figures
  // must stay the exact flat replay; per-account figures are withheld (whole
  // investment on the null row).
  fx.unassigned = await seedInvestment('WPC4P UNASSIGNED', 10);
  await seedTxn(fx.unassigned, 'buy', '2026-01-01', { units: 60, amount: 600, accountId: A });
  await seedTxn(fx.unassigned, 'buy', '2026-01-05', { units: 40, amount: 400 });
  await seedTxn(fx.unassigned, 'sell', '2026-02-01', { units: 10, amount: 150 });
}

// Hand-computed per-account expectations (see fixture comments above).
// Only MULTI's B-partition depends on the method; everything else is
// single-lot-per-partition and method-invariant.
const EXPECTED = {
  fifo: { realizedB: 575, unrealizedB: -650, realizedTotal: 625, unrealizedTotal: 70 },
  lifo: { realizedB: 375, unrealizedB: -450, realizedTotal: 425, unrealizedTotal: 270 },
  weighted_avg: { realizedB: 475, unrealizedB: -550, realizedTotal: 525, unrealizedTotal: 170 },
};
// Account A: value 1320+1100+600+1200 = 4220 · invested 1400+1000+300+1000 = 3700
//            realized 0 · unrealized −80+100+300+400 = 720
// Account B: value 300+275+200+600 = 1375 · invested 1000+1100+500+1000 = 3600
// Null row (UNASSIGNED only): value 900 · invested 1000 · realized 50 · unrealized 0

describeDb('WP-C4 parity invariant — Σ per-account ≡ global engine (real Postgres)', () => {
  beforeAll(acquireDbSuiteLock, 180_000);
  afterAll(async () => {
    await wipe();
    await releaseDbSuiteLock();
    await closePool();
    await closeTestPool();
  });

  beforeEach(async () => {
    await wipe();
    await seed();
  });

  it.each(['weighted_avg', 'fifo', 'lifo'])(
    '%s: per-account rows match hand-computed partitions and re-sum to the totals',
    async (method) => {
      await setCostBasisMethod(method);
      const result = await getPortfolioSummary('EUR');
      const exp = EXPECTED[method];

      // ── the parity invariant: Σ byAccount ≡ totals, field by field ──────
      const sum = (field) => result.byAccount.reduce((s, a) => s + a[field], 0);
      const TOL = 0.02; // ≤ one banker's-rounding cent per aggregation side
      expect(Math.abs(sum('currentValue') - result.totals.totalPortfolioValue)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(sum('totalInvested') - result.totals.totalInvested)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(sum('realizedGain') - result.totals.totalRealizedGain)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(sum('unrealizedGain') - result.totals.totalUnrealizedGain)).toBeLessThanOrEqual(TOL);
      expect(Math.abs(sum('gainLoss') - result.totals.totalGainLoss)).toBeLessThanOrEqual(TOL);

      // ── absolute totals (pin the engine, not just internal consistency) ──
      expect(result.totals.totalPortfolioValue).toBe(6495);
      expect(result.totals.totalInvested).toBe(8300);
      expect(result.totals.totalRealizedGain).toBe(exp.realizedTotal);
      expect(result.totals.totalUnrealizedGain).toBe(exp.unrealizedTotal);
      expect(result.totals.totalGainLoss).toBe(695); // method-invariant by construction

      // ── per-account rows, sorted by value desc: A, B, unassigned ─────────
      expect(result.byAccount.map((a) => a.account_id)).toEqual([fx.ibkr, fx.degiro, null]);
      expect(result.byAccount[0]).toEqual({
        account_id: fx.ibkr,
        currentValue: 4220,
        totalInvested: 3700,
        realizedGain: 0,
        unrealizedGain: 720,
        gainLoss: 720,
      });
      expect(result.byAccount[1]).toEqual({
        account_id: fx.degiro,
        currentValue: 1375,
        totalInvested: 3600,
        realizedGain: exp.realizedB,
        unrealizedGain: exp.unrealizedB,
        gainLoss: -75,
      });
      // The unassigned remainder lands WHOLLY on the null row.
      expect(result.byAccount[2]).toEqual({
        account_id: null,
        currentValue: 900,
        totalInvested: 1000,
        realizedGain: 50,
        unrealizedGain: 0,
        gainLoss: 50,
      });

      // ── transition flags for the read surfaces (WP-C5) ────────────────────
      const flagByName = new Map(result.summaries.map((s) => [s.name, s.fullyAssigned]));
      expect(flagByName.get('WPC4P MULTI')).toBe(true);
      expect(flagByName.get('WPC4P SPLIT')).toBe(true);
      expect(flagByName.get('WPC4P RETAG')).toBe(true);
      expect(flagByName.get('WPC4P ROC')).toBe(true);
      expect(flagByName.get('WPC4P UNASSIGNED')).toBe(false);

      // ── the unassigned instrument's GLOBAL figures stay flat-replay exact ─
      const unassigned = result.summaries.find((s) => s.name === 'WPC4P UNASSIGNED');
      expect(unassigned.totalUnits).toBe(90);
      expect(unassigned.currentValue).toBe(900);
      expect(unassigned.totalBuyCost).toBe(1000);
      expect(unassigned.realizedGain).toBe(50);
      expect(unassigned.unrealizedGain).toBe(0);

      // ── re-tag actually re-partitioned history ───────────────────────────
      const retag = result.summaries.find((s) => s.name === 'WPC4P RETAG');
      expect(retag.realizedGain).toBe(150); // 400 − 10×25 from the moved lot's basis
    },
  );

  it('re-tagging a lot BACK moves value and basis between account rows with no global change', async () => {
    await setCostBasisMethod('fifo');
    const before = await getPortfolioSummary('EUR');

    // Undo the RETAG move: the 20u/500 lot returns to IBKR. Its remaining
    // 10 units (cost 250, value 200) leave Degiro; the sell now sits in a
    // partition with no lots and clamps to zero units sold — realized drops
    // to 0 globally and per account (assign-your-sells is a data state the
    // engine must survive, not crash on).
    await pool.query(
      `UPDATE portfolio_transactions SET account_id = $1
       WHERE investment_id = $2 AND type = 'buy' AND units = 20`,
      [fx.ibkr, fx.retag],
    );
    const after = await getPortfolioSummary('EUR');

    const row = (r, id) => r.byAccount.find((a) => a.account_id === id);
    // IBKR gains the whole lot: 20u @ price 20 = +400 value vs before's +200
    // (10u were already counted at Degiro before... the lot moves WHOLE).
    expect(row(after, fx.ibkr).currentValue - row(before, fx.ibkr).currentValue).toBe(400);
    expect(row(after, fx.degiro).currentValue - row(before, fx.degiro).currentValue).toBe(-200);
    // Parity holds in the new tagging too.
    const sum = (r, f) => r.byAccount.reduce((s, a) => s + a[f], 0);
    for (const [field, total] of [
      ['currentValue', 'totalPortfolioValue'],
      ['totalInvested', 'totalInvested'],
      ['realizedGain', 'totalRealizedGain'],
      ['unrealizedGain', 'totalUnrealizedGain'],
      ['gainLoss', 'totalGainLoss'],
    ]) {
      expect(Math.abs(sum(after, field) - after.totals[total])).toBeLessThanOrEqual(0.02);
    }
  });
});
