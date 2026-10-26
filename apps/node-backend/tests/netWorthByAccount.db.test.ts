/**
 * GET /api/info/net-worth/by-account against real PostgreSQL: each account's
 * cash balance converted at the latest stored rate, live holdings partitions
 * per account and unassigned, and the displayed total (ADR-093, ADR-216).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import { invalidatePortfolioCaches } from "../src/services/info/cache.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import netWorthRouter from "../src/routes/info/netWorth.ts";
import { must } from "./helpers/must.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;
const pool = () => must(getTestPool(), "getTestPool()");
let recipientId: number;

async function wipe() {
  await pool().query("DELETE FROM portfolio_transactions");
  await pool().query("DELETE FROM investments");
  await pool().query("DELETE FROM transactions");
  await pool().query("DELETE FROM accounts");
  await pool().query("DELETE FROM recipients");
  await pool().query("DELETE FROM exchange_rates");
}

async function account(
  name: string,
  {
    type = "checking",
    currency = "EUR",
    inNetWorth = true,
  }: { type?: string; currency?: string; inNetWorth?: boolean } = {},
) {
  const { rows } = await pool().query<{ id: number }>(
    `INSERT INTO accounts (name, display_name, type, currency, in_net_worth)
     VALUES ($1, $1, $2::account_type, $3, $4) RETURNING id`,
    [name, type, currency, inNetWorth],
  );
  return must(rows[0], "rows[0]").id;
}

async function cash(accountId: number, amount: string, currency = "EUR") {
  await pool().query(
    `INSERT INTO transactions (date, amount, currency, recipient_id, account_id)
     VALUES (CURRENT_DATE - 1, $1, $2, $3, $4)`,
    [amount, currency, recipientId, accountId],
  );
}

/** A stock of `units` bought for `cost`, priced at `price`, held at `accountId`. */
async function holding(
  name: string,
  accountId: number | null,
  { units, cost, price }: { units: number; cost: number; price: number },
) {
  const { rows } = await pool().query<{ id: number }>(
    `INSERT INTO investments (name, symbol, asset_class, currency, current_price)
     VALUES ($1, $1, 'stock', 'EUR', $2) RETURNING id`,
    [name, price],
  );
  await pool().query(
    `INSERT INTO portfolio_transactions (investment_id, type, date, amount, units, currency, account_id)
     VALUES ($1, 'buy', '2026-01-02', $2, $3, 'EUR', $4)`,
    [must(rows[0], "rows[0]").id, cost, units, accountId],
  );
}

describeDb("GET /api/info/net-worth/by-account (real DB)", () => {
  const api = routeAgent(netWorthRouter, { mountPath: "/api/info" });

  beforeAll(async () => {
    await acquireDbSuiteLock();
  });

  beforeEach(async () => {
    await wipe();
    invalidatePortfolioCaches();
    clearMemoryCache();
    const { rows } = await pool().query<{ id: number }>(
      `INSERT INTO recipients (name, normalized_name) VALUES ('Synthetic payee', 'synthetic payee') RETURNING id`,
    );
    recipientId = must(rows[0], "rows[0]").id;
    await pool().query(
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
       VALUES ('USD', 0.9, CURRENT_DATE, true)`,
    );
  });

  afterAll(async () => {
    await wipe();
    invalidatePortfolioCaches();
    clearMemoryCache();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("converts cash at the latest rate and adds each account's holdings", async () => {
    const usdCash = await account("Daily cash", { currency: "USD" });
    await cash(usdCash, "1000.00", "USD");
    const broker = await account("Broker", { type: "brokerage" });
    await cash(broker, "100.00");
    await holding("Synthetic stock", broker, {
      units: 10,
      cost: 100,
      price: 15,
    });
    // Holdings-only accounts count no ledger cash.
    const wallet = await account("Wallet", { type: "wallet" });
    await cash(wallet, "999.00");
    // Outside net worth and without holdings: no row.
    const tracking = await account("Tracking", { inNetWorth: false });
    await cash(tracking, "400.00");
    await holding("Loose stock", null, { units: 1, cost: 5, price: 50 });

    const res = await api.get("/api/info/net-worth/by-account?currency=EUR");

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data")).toEqual({
      currency: "EUR",
      rows: [
        {
          accountId: usdCash,
          name: "Daily cash",
          type: "checking",
          cashCurrency: "USD",
          // 1 000 USD × 0.9.
          cash: 900,
          holdings: 0,
          total: 900,
          unconverted: false,
        },
        {
          accountId: broker,
          name: "Broker",
          type: "brokerage",
          cashCurrency: "EUR",
          cash: 100,
          // 10 units × 15.
          holdings: 150,
          total: 250,
          unconverted: false,
        },
        {
          accountId: wallet,
          name: "Wallet",
          type: "wallet",
          cashCurrency: "EUR",
          cash: 0,
          holdings: 0,
          total: 0,
          unconverted: false,
        },
        {
          accountId: null,
          name: null,
          type: null,
          cashCurrency: null,
          cash: 0,
          holdings: 50,
          total: 50,
          unconverted: false,
        },
      ],
      // 900 + 250 + 0 + 50.
      total: 1200,
      unconvertedAccountIds: [],
    });
  });

  it("converts into a non-EUR display currency through EUR", async () => {
    const eurCash = await account("Euro cash");
    await cash(eurCash, "90.00");

    const res = await api.get("/api/info/net-worth/by-account?currency=USD");

    expect(res.status).toBe(200);
    // 90 EUR / 0.9.
    expect(bodyAt(res, "data", "rows", 0, "cash")).toBe(100);
    expect(bodyAt(res, "data", "total")).toBe(100);
  });

  it("flags a cash balance without a stored rate and withholds the total", async () => {
    const eurCash = await account("Euro cash");
    await cash(eurCash, "10.00");
    const pesos = await account("Pesos", { currency: "ARS" });
    await cash(pesos, "5000.00", "ARS");

    const res = await api.get("/api/info/net-worth/by-account?currency=EUR");

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "rows", 1)).toMatchObject({
      accountId: pesos,
      cash: null,
      total: null,
      unconverted: true,
    });
    expect(bodyAt(res, "data", "rows", 0, "total")).toBe(10);
    expect(bodyAt(res, "data", "total")).toBeNull();
    expect(bodyAt(res, "data", "unconvertedAccountIds")).toEqual([pesos]);
  });

  it("rejects a repeated currency", async () => {
    const res = await api.get(
      "/api/info/net-worth/by-account?currency=EUR&currency=USD",
    );
    expect(res.status).toBe(400);
  });
});
