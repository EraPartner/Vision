/**
 * ADR-108 WP-C4 — account-scoped sell validation against real Postgres.
 *
 * Pins the two halves of the acceptance:
 *  - a sell exceeding BROKER-LOCAL units is rejected with a message naming
 *    the broker (its display name), even when investment-wide units would
 *    cover it;
 *  - the SAME sell passes while the instrument still has unassigned lots
 *    (transition rule: validation stays global), and an unassigned sell on a
 *    fully-assigned instrument also validates globally.
 *
 * Also pins that the per-account availability replay applies splits
 * investment-wide (a broker's units are rescaled by the global ratio), and
 * that the update path re-validates against the row's EFFECTIVE post-patch
 * account.
 *
 * Uses portfolioTransactionRepository.create/update — the exact seam both the
 * manual routes and the import commit path (commit.js) go through.
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
import { portfolioTransactionRepository } from '../src/repositories/portfolioTransactionRepository.js';

const pool = getTestPool();
const describeDb = hasTestDatabase() ? describe : describe.skip;

const fx = {};

async function seedAccount(name, displayName) {
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $2) RETURNING id`,
    [name, displayName],
  );
  return rows[0].id;
}

async function seedInvestment(name) {
  const { rows } = await pool.query(
    `INSERT INTO investments (name, symbol, asset_class, currency, current_price)
     VALUES ($1, $1, 'stock', 'EUR', 10) RETURNING id`,
    [name],
  );
  return rows[0].id;
}

const trade = (investmentId, type, date, units, accountId) => ({
  investment_id: investmentId,
  type,
  date,
  units,
  price_per_unit: 10,
  account_id: accountId,
});

async function wipe() {
  await pool.query(`DELETE FROM portfolio_transactions`);
  await pool.query(`DELETE FROM investments WHERE name LIKE 'WPC4V %'`);
  await pool.query(`DELETE FROM accounts WHERE name LIKE 'WPC4V %'`);
}

describeDb('WP-C4 account-scoped sell validation (real Postgres)', () => {
  beforeAll(acquireDbSuiteLock, 180_000);
  afterAll(async () => {
    await wipe();
    await releaseDbSuiteLock();
    await closePool();
    await closeTestPool();
  });

  beforeEach(async () => {
    await wipe();
    fx.ibkr = await seedAccount('WPC4V IBKR', 'Interactive Brokers');
    fx.degiro = await seedAccount('WPC4V DEGIRO', 'Degiro');
  });

  it('rejects a broker-local overdraw NAMING the broker, even though global units cover it', async () => {
    const inv = await seedInvestment('WPC4V BASIC');
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-01', 100, fx.ibkr));
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-02', 20, fx.degiro));

    // 50 ≤ 120 globally, but Degiro only holds 20.
    await expect(
      portfolioTransactionRepository.create(trade(inv, 'sell', '2026-02-01', 50, fx.degiro)),
    ).rejects.toThrow(/available holdings at Degiro/);

    // The same 50 at IBKR (which holds 100) is fine.
    await expect(
      portfolioTransactionRepository.create(trade(inv, 'sell', '2026-02-01', 50, fx.ibkr)),
    ).resolves.toMatchObject({ type: 'sell', account_id: fx.ibkr });
  });

  it('transition rule: the SAME overdrawing sell passes while an unassigned lot exists', async () => {
    const inv = await seedInvestment('WPC4V TRANSITION');
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-01', 100, fx.ibkr));
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-02', 20, fx.degiro));
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-03', 30, null)); // unassigned lot

    // Broker-local overdraw at Degiro, but validation stays GLOBAL (150 held).
    await expect(
      portfolioTransactionRepository.create(trade(inv, 'sell', '2026-02-01', 50, fx.degiro)),
    ).resolves.toMatchObject({ type: 'sell', account_id: fx.degiro });

    // Global limits still apply during the transition.
    await expect(
      portfolioTransactionRepository.create(trade(inv, 'sell', '2026-02-02', 150, fx.degiro)),
    ).rejects.toThrow('sell units exceed available holdings');
  });

  it('an UNASSIGNED sell on a fully-assigned instrument validates globally (no broker to scope to)', async () => {
    const inv = await seedInvestment('WPC4V NULLSELL');
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-01', 10, fx.ibkr));

    await expect(
      portfolioTransactionRepository.create(trade(inv, 'sell', '2026-02-01', 5, null)),
    ).resolves.toMatchObject({ type: 'sell', account_id: null });
    await expect(
      portfolioTransactionRepository.create(trade(inv, 'sell', '2026-02-02', 15, null)),
    ).rejects.toThrow('sell units exceed available holdings');
  });

  it('per-broker availability replays splits investment-wide', async () => {
    const inv = await seedInvestment('WPC4V SPLIT');
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-01', 10, fx.ibkr));
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-02', 10, fx.degiro));
    // 2:1 split → 40 units globally, 20 per broker.
    await pool.query(
      `INSERT INTO portfolio_transactions (investment_id, type, date, amount, units, currency)
       VALUES ($1, 'split', '2026-02-01', 0, 40, 'EUR')`,
      [inv],
    );

    // 15 > pre-split 10 but ≤ post-split 20 at Degiro — must pass.
    await expect(
      portfolioTransactionRepository.create(trade(inv, 'sell', '2026-03-01', 15, fx.degiro)),
    ).resolves.toMatchObject({ type: 'sell' });
    // Degiro now holds 5; 25 would need IBKR's units — rejected, named.
    await expect(
      portfolioTransactionRepository.create(trade(inv, 'sell', '2026-03-02', 25, fx.degiro)),
    ).rejects.toThrow(/available holdings at Degiro/);
  });

  it('update path validates against the row\'s EFFECTIVE post-patch account', async () => {
    const inv = await seedInvestment('WPC4V UPDATE');
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-01', 100, fx.ibkr));
    await portfolioTransactionRepository.create(trade(inv, 'buy', '2026-01-02', 20, fx.degiro));
    const sale = await portfolioTransactionRepository.create(trade(inv, 'sell', '2026-02-01', 10, fx.degiro));

    // Growing the sell beyond Degiro's 20 units fails, naming the broker…
    await expect(
      portfolioTransactionRepository.update(sale.id, { units: 25, price_per_unit: 10 }),
    ).rejects.toThrow(/available holdings at Degiro/);
    // …but re-pointing the same sell to IBKR (100 units) succeeds.
    await expect(
      portfolioTransactionRepository.update(sale.id, { units: 25, price_per_unit: 10, account_id: fx.ibkr }),
    ).resolves.toMatchObject({ account_id: fx.ibkr });
  });
});
