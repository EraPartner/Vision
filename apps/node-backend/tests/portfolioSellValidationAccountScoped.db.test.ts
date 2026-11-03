/**
 * ADR-108 WP-C4 — account-scoped sell validation against the real (SQLite) database.
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
 * Uses portfolioTransactionService.create/update — the policy seam both the
 * manual routes and the import commit path go through.
 *
 * The second suite pins the exact-decimal boundaries of the SQLite port
 * (ADR-263): quantities that do not add up in binary floating point, a price
 * with more decimals than its column, half-away-from-zero rounding, a sale
 * that closes a position to exactly zero, and the tax report figures.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPool, getTestPool } from "./setup/db.ts";
import type { TestPool } from "./setup/db.ts";

import { closePool } from "../src/database/connection.ts";
import portfolioTransactionService from "../src/services/portfolio/portfolioTransactionService.ts";
import portfolioTransactionRepository from "../src/repositories/portfolioTransactionRepository.ts";
import { getPortfolioSummary } from "../src/services/portfolio/portfolioSummaryService.ts";
import { fetchTaxData } from "../src/services/reports/dataFetcherTax.ts";
import type { PortfolioTransactionInput } from "../src/services/portfolio/portfolioTransactionRules.ts";
import {
  asAccountId,
  asCurrencyCode,
  asInvestmentId,
  asPortfolioTransactionId,
} from "@vision/types/brands";
import { must } from "./helpers/must.ts";

let pool: TestPool;

// Seeded in beforeEach.
const fx = {} as { ibkr: number; degiro: number };

async function seedAccount(name: string, displayName: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (name, display_name) VALUES ($1, $2) RETURNING id`,
    [name, displayName],
  );
  return must(rows[0], "rows[0]").id;
}

async function seedInvestment(name: string) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO investments (name, symbol, asset_class, currency, current_price)
     VALUES ($1, $1, 'stock', 'EUR', vision_numeric('10', 18, 6)) RETURNING id`,
    [name],
  );
  return must(rows[0], "rows[0]").id;
}

const trade = (
  investmentId: number,
  type: string,
  date: string,
  units: number,
  accountId: number | null,
): PortfolioTransactionInput => ({
  investment_id: asInvestmentId(investmentId),
  type,
  date,
  units,
  price_per_unit: 10,
  currency: asCurrencyCode("EUR"),
  account_id: accountId == null ? null : asAccountId(accountId),
});

async function wipe() {
  await pool.query(`DELETE FROM portfolio_transactions`);
  await pool.query(`DELETE FROM investments WHERE name LIKE 'WPC4V %'`);
  await pool.query(`DELETE FROM accounts WHERE name LIKE 'WPC4V %'`);
}

describe("WP-C4 account-scoped sell validation (real DB)", () => {
  beforeAll(() => {
    pool = must(getTestPool(), "test pool");
  });
  afterAll(async () => {
    await wipe();
    await closePool();
    await closeTestPool();
  });

  beforeEach(async () => {
    await wipe();
    fx.ibkr = await seedAccount("WPC4V IBKR", "Interactive Brokers");
    fx.degiro = await seedAccount("WPC4V DEGIRO", "Degiro");
  });

  it("rejects a broker-local overdraw NAMING the broker, even though global units cover it", async () => {
    const inv = await seedInvestment("WPC4V BASIC");
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-01", 100, fx.ibkr),
    );
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-02", 20, fx.degiro),
    );

    // 50 ≤ 120 globally, but Degiro only holds 20.
    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-02-01", 50, fx.degiro),
      ),
    ).rejects.toThrow(/available holdings at Degiro/);

    // The same 50 at IBKR (which holds 100) is fine.
    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-02-01", 50, fx.ibkr),
      ),
    ).resolves.toMatchObject({ type: "sell", account_id: fx.ibkr });
  });

  it("transition rule: the SAME overdrawing sell passes while an unassigned lot exists", async () => {
    const inv = await seedInvestment("WPC4V TRANSITION");
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-01", 100, fx.ibkr),
    );
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-02", 20, fx.degiro),
    );
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-03", 30, null),
    ); // unassigned lot

    // Broker-local overdraw at Degiro, but validation stays GLOBAL (150 held).
    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-02-01", 50, fx.degiro),
      ),
    ).resolves.toMatchObject({ type: "sell", account_id: fx.degiro });

    // Global limits still apply during the transition.
    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-02-02", 150, fx.degiro),
      ),
    ).rejects.toThrow("sell units exceed available holdings");
  });

  it("an UNASSIGNED sell on a fully-assigned instrument validates globally (no broker to scope to)", async () => {
    const inv = await seedInvestment("WPC4V NULLSELL");
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-01", 10, fx.ibkr),
    );

    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-02-01", 5, null),
      ),
    ).resolves.toMatchObject({ type: "sell", account_id: null });
    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-02-02", 15, null),
      ),
    ).rejects.toThrow("sell units exceed available holdings");
  });

  it("per-broker availability replays splits investment-wide", async () => {
    const inv = await seedInvestment("WPC4V SPLIT");
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-01", 10, fx.ibkr),
    );
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-02", 10, fx.degiro),
    );
    // 2:1 split → 40 units globally, 20 per broker.
    await pool.query(
      `INSERT INTO portfolio_transactions (investment_id, type, date, amount, units, currency)
       VALUES ($1, 'split', '2026-02-01', vision_numeric('0', 18, 4), vision_numeric('40', 18, 8), 'EUR')`,
      [inv],
    );

    // 15 > pre-split 10 but ≤ post-split 20 at Degiro — must pass.
    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-03-01", 15, fx.degiro),
      ),
    ).resolves.toMatchObject({ type: "sell" });
    // Degiro now holds 5; 25 would need IBKR's units — rejected, named.
    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-03-02", 25, fx.degiro),
      ),
    ).rejects.toThrow(/available holdings at Degiro/);
  });

  it("update path validates against the row's EFFECTIVE post-patch account", async () => {
    const inv = await seedInvestment("WPC4V UPDATE");
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-01", 100, fx.ibkr),
    );
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-02", 20, fx.degiro),
    );
    const sale = await portfolioTransactionService.create(
      trade(inv, "sell", "2026-02-01", 10, fx.degiro),
    );

    // Growing the sell beyond Degiro's 20 units fails, naming the broker…
    await expect(
      portfolioTransactionService.update(must(sale, "sale").id, {
        units: 25,
        price_per_unit: 10,
      }),
    ).rejects.toThrow(/available holdings at Degiro/);
    // …but re-pointing the same sell to IBKR (100 units) succeeds.
    await expect(
      portfolioTransactionService.update(must(sale, "sale").id, {
        units: 25,
        price_per_unit: 10,
        account_id: fx.ibkr,
      }),
    ).resolves.toMatchObject({ account_id: fx.ibkr });
  });
});

describe("exact decimal boundaries (real DB)", () => {
  beforeAll(() => {
    pool = must(getTestPool(), "test pool");
  });
  afterAll(async () => {
    await wipe();
  });

  beforeEach(async () => {
    await wipe();
    fx.ibkr = await seedAccount("WPC4V IBKR", "Interactive Brokers");
    fx.degiro = await seedAccount("WPC4V DEGIRO", "Degiro");
  });

  /** The stored canonical text of one transaction's decimal columns. */
  async function stored(id: number) {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT amount, units, price_per_unit, fees, taxes FROM portfolio_transactions WHERE id = $1`,
      [id],
    );
    return must(rows[0], "stored row");
  }

  it("stores 0.1 + 0.2 units exactly and sums them to 0.3, not 0.30000000000000004", async () => {
    const inv = await seedInvestment("WPC4V POINT");
    const first = await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-01", 0.1, fx.ibkr),
    );
    const second = await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-02", 0.2, fx.ibkr),
    );
    expect((await stored(Number(first?.id))).units).toBe("0.10000000");
    expect((await stored(Number(second?.id))).units).toBe("0.20000000");

    const { rows } = await pool.query<{ total: string }>(
      `SELECT dec_sum(units) AS total FROM portfolio_transactions WHERE investment_id = $1`,
      [inv],
    );
    expect(rows).toEqual([{ total: "0.30000000" }]);
    const buys = (await portfolioTransactionRepository.getSummary(asInvestmentId(inv))).find(
      (row) => row.type === "buy",
    );
    expect(buys).toMatchObject({ total_units: 0.3, total_amount: 3, count: 2 });
  });

  it("closes a lot exactly: 0.3 bought, 0.1 then 0.2 sold, nothing left to sell", async () => {
    const inv = await seedInvestment("WPC4V CLOSE");
    await portfolioTransactionService.create(
      trade(inv, "buy", "2026-01-01", 0.3, fx.ibkr),
    );
    await portfolioTransactionService.create(
      trade(inv, "sell", "2026-02-01", 0.1, fx.ibkr),
    );
    // 0.3 - 0.1 is 0.19999999999999998 in binary floating point; the sale of
    // the remaining 0.2 must still pass.
    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-02-02", 0.2, fx.ibkr),
      ),
    ).resolves.toMatchObject({ type: "sell" });
    // The position is closed: anything beyond the replay's 1e-8 tolerance is
    // refused.
    await expect(
      portfolioTransactionService.create(
        trade(inv, "sell", "2026-02-03", 0.00000002, fx.ibkr),
      ),
    ).rejects.toThrow(/available holdings at Interactive Brokers \(0 units held there\)/);

    const { rows } = await pool.query<{ held: string }>(
      `SELECT dec_sum(CASE WHEN type = 'sell' THEN dec_neg(units) ELSE units END) AS held
         FROM portfolio_transactions WHERE investment_id = $1`,
      [inv],
    );
    // The stored quantities net to exactly zero.
    expect(rows).toEqual([{ held: "0.00000000" }]);
  });

  it("realizes the exact gain of a sale that fully closes a lot, for every cost-basis method", async () => {
    const inv = await seedInvestment("WPC4V REALIZE");
    // 0.1 for 1.10 and 0.2 for 2.20 (cost 3.30), all 0.3 sold for 3.60.
    const leg = (type: string, date: string, units: number, price: number, amount: number) =>
      portfolioTransactionService.create({
        ...trade(inv, type, date, units, fx.ibkr),
        amount,
        price_per_unit: price,
      });
    await leg("buy", "2026-01-01", 0.1, 11, 1.1);
    await leg("buy", "2026-01-02", 0.2, 11, 2.2);
    await leg("sell", "2026-03-01", 0.3, 12, 3.6);

    for (const method of ["weighted_avg", "fifo", "lifo"]) {
      await pool.query(
        `INSERT INTO user_settings (key, value) VALUES ('cost_basis_method', vision_jsonb(json_quote($1)))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [method],
      );
      const summary = await getPortfolioSummary("EUR");
      const row = must(
        summary.summaries.find((item) => item.id === inv),
        "closed investment summary",
      );
      expect(row).toMatchObject({
        totalUnits: 0,
        currentValue: 0,
        totalBuyCost: 3.3,
        totalSellProceeds: 3.6,
        realizedGain: 0.3,
        unrealizedGain: 0,
      });
    }
    await pool.query("DELETE FROM user_settings WHERE key = 'cost_basis_method'");
  });

  it("rounds a 28-decimal price to the column scale, half away from zero, on insert and update", async () => {
    const inv = await seedInvestment("WPC4V PRICE");
    const insert = (price: string) =>
      portfolioTransactionRepository.insert({
        investment_id: asInvestmentId(inv),
        type: "buy",
        date: "2026-01-01",
        amount: "1",
        units: "1",
        price_per_unit: price,
        currency: asCurrencyCode("EUR"),
        account_id: asAccountId(fx.ibkr),
      });

    // 28 decimals into NUMERIC(18,6).
    const long = must(await insert("1.2345678901234567890123456789"), "long price row");
    expect((await stored(Number(long.id))).price_per_unit).toBe("1.234568");
    // Just below the half: exact decimal math keeps 0.000000, while the same
    // text through a binary float (5e-7) would round up to 0.000001.
    const below = must(await insert("0.0000004999999999999999999999"), "below-half row");
    expect((await stored(Number(below.id))).price_per_unit).toBe("0.000000");
    // An exact half rounds away from zero (PostgreSQL), not to even.
    const half = must(await insert("-2.0000005"), "half row");
    expect((await stored(Number(half.id))).price_per_unit).toBe("-2.000001");

    // The hand-written UPDATE path rounds the same way.
    await portfolioTransactionRepository.updateFields(
      asPortfolioTransactionId(Number(long.id)),
      {
        price_per_unit: "9.9999995000000000000000000000",
        amount: "0.00005",
        fees: "-0.00005",
        units: "0.123456785",
      },
    );
    expect(await stored(Number(long.id))).toMatchObject({
      price_per_unit: "10.000000",
      amount: "0.0001",
      fees: "-0.0001",
      units: "0.12345679",
    });
  });

  it("reports the same tax figures: exact sums, inclusive year bounds, months from the DATE", async () => {
    const inv = await seedInvestment("WPC4V TAX");
    const row = async (
      type: string,
      date: string,
      amount: string,
      taxes: string,
      fees: string,
    ) =>
      pool.query(
        `INSERT INTO portfolio_transactions
           (investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency,
            dividend_amount_convention, account_id)
         VALUES ($1, $2, $3, vision_numeric($4, 18, 4), NULL, NULL, vision_numeric($5, 18, 4),
                 vision_numeric($6, 18, 4), 'EUR', 'net', $7)`,
        [inv, type, date, amount, fees, taxes, fx.ibkr],
      );
    await row("buy", "2023-12-31", "100", "9", "9"); // before the year
    await row("buy", "2024-01-01", "100", "0.1", "0.2"); // first day
    await row("buy", "2024-03-01", "100", "0", "0"); // no tax, no fee: excluded
    await row("dividend", "2024-06-30", "10.25", "1.5", "0");
    await row("sell", "2024-12-31", "100", "0.2", "0.1"); // last day
    await row("buy", "2025-01-01", "100", "5", "5"); // after the year

    const data = await fetchTaxData("EUR", { kind: "year", year: 2024 });
    expect(data).toMatchObject({
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      tobTotal: 0.3,
      feesTotal: 0.3,
      dividendWHTTotal: 1.5,
      dividendsReceived: 10.25,
      otherTaxTotal: 0,
      sellTaxTotal: 0,
    });
    expect(
      data.byMonth.map(({ year, month, tob, wht, fees }) => ({ year, month, tob, wht, fees })),
    ).toEqual([
      { year: 2024, month: 1, tob: 0.1, wht: 0, fees: 0.2 },
      { year: 2024, month: 6, tob: 0, wht: 1.5, fees: 0 },
      { year: 2024, month: 12, tob: 0.2, wht: 0, fees: 0.1 },
    ]);
  });
});
