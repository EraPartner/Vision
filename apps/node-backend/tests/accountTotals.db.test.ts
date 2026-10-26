/**
 * GET /api/accounts/totals against real PostgreSQL: the accounts hub's
 * converted balances, group subtotals and "Net cash" are computed on the
 * server (ADR-216). Each balance partition converts at the latest stored rate;
 * a partition without a rate is left out and its account counted, never added
 * 1:1 or at a hard-coded constant.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import accountsRouter from "../src/routes/accounts.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import { must } from "./helpers/must.ts";
import { arrayContaining } from "./helpers/matchers.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;

interface AccountSeed {
  type?: string;
  currency?: string;
  inNetWorth?: boolean;
  isActive?: boolean;
}

async function addAccount(
  name: string,
  {
    type = "checking",
    currency = "EUR",
    inNetWorth = true,
    isActive = true,
  }: AccountSeed = {},
): Promise<number> {
  const { rows } = await must(getTestPool(), "getTestPool()").query<{ id: number }>(
    `INSERT INTO accounts (name, type, currency, in_net_worth, is_active)
     VALUES ($1, $2::account_type, $3, $4, $5) RETURNING id`,
    [name, type, currency, inNetWorth, isActive],
  );
  return must(rows[0], "row").id;
}

const PAYEE = `account_totals_${process.pid}`;

async function addTxn(accountId: number, amount: string, currency = "EUR") {
  await must(getTestPool(), "getTestPool()").query(
    `WITH payee AS (
       INSERT INTO recipients (name, normalized_name) VALUES ($4, $4)
       ON CONFLICT (normalized_name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id
     )
     INSERT INTO transactions (date, amount, currency, account_id, recipient_id)
     SELECT CURRENT_DATE - 1, $1, $2, $3, id FROM payee`,
    [amount, currency, accountId, PAYEE],
  );
}

describeDb("GET /api/accounts/totals (real DB)", () => {
  const api = routeAgent(accountsRouter, { mountPath: "/api/accounts" });
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    await acquireDbSuiteLock();
  }, 180_000);

  async function seed() {
    await must(getTestPool(), "getTestPool()").query(
      `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
       VALUES ('USD', '0.5', CURRENT_DATE, true)`,
    );
    // 100 EUR + 100 USD in one account: 100 + 100 × 0.5 = 150 EUR.
    ids.checking = await addAccount("Checking");
    await addTxn(ids.checking, "100");
    await addTxn(ids.checking, "100", "USD");
    // 200 USD = 100 EUR.
    ids.savings = await addAccount("USD savings", {
      type: "savings",
      currency: "USD",
    });
    await addTxn(ids.savings, "200", "USD");
    ids.card = await addAccount("Card", { type: "liability" });
    await addTxn(ids.card, "-40");
    // In the Cash group subtotal, outside Net cash.
    ids.excluded = await addAccount("Excluded", {
      type: "savings",
      inNetWorth: false,
    });
    await addTxn(ids.excluded, "1000");
    // No stored GBP rate: left out and counted.
    ids.gbp = await addAccount("GBP pot", { type: "savings", currency: "GBP" });
    await addTxn(ids.gbp, "50", "GBP");
    // Broker cash counts in the Portfolio subtotal; holdings-only types do not.
    ids.broker = await addAccount("Broker", { type: "brokerage" });
    await addTxn(ids.broker, "25");
    ids.wallet = await addAccount("Wallet", { type: "wallet" });
    await addTxn(ids.wallet, "999");
    // Archived whatever its type, outside Net cash.
    ids.old = await addAccount("Old", { isActive: false });
    await addTxn(ids.old, "10");
  }

  afterEach(async () => {
    const pool = must(getTestPool(), "getTestPool()");
    await pool.query("DELETE FROM transactions");
    await pool.query("DELETE FROM accounts");
    await pool.query("DELETE FROM recipients WHERE normalized_name = $1", [
      PAYEE,
    ]);
    await pool.query("DELETE FROM exchange_rates");
    clearMemoryCache();
    invalidatePortfolioCaches();
  });

  afterAll(async () => {
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  it("converts every partition and sums groups and net cash on the server", async () => {
    await seed();

    const res = await api.get("/api/accounts/totals?currency=EUR");

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "currency")).toBe("EUR");
    // 150 + 100 - 40; GBP pot left out, Excluded / Broker / Old outside the population.
    expect(bodyAt(res, "data", "net_cash")).toEqual({
      total: 210,
      unconverted_count: 1,
      unconverted_currencies: ["GBP"],
    });
    expect(bodyAt(res, "data", "groups")).toEqual({
      cash: {
        total: 1250,
        cash: 1250,
        holdings: 0,
        holdings_unavailable: false,
        unconverted_count: 1,
        unconverted_currencies: ["GBP"],
      },
      portfolio: {
        total: 25,
        cash: 25,
        holdings: 0,
        holdings_unavailable: false,
        unconverted_count: 0,
        unconverted_currencies: [],
      },
      liabilities: {
        total: -40,
        cash: -40,
        holdings: 0,
        holdings_unavailable: false,
        unconverted_count: 0,
        unconverted_currencies: [],
      },
      archived: {
        total: 10,
        cash: 10,
        holdings: 0,
        holdings_unavailable: false,
        unconverted_count: 0,
        unconverted_currencies: [],
      },
    });
    const accounts = bodyAt(res, "data", "accounts") as Array<{ id: number }>;
    const byId = (id: number | undefined) => accounts.find((a) => a.id === id);
    expect(byId(ids.checking)).toEqual({
      id: ids.checking,
      group: "cash",
      converted_balance: 150,
      unconverted_currencies: [],
    });
    expect(byId(ids.gbp)).toEqual({
      id: ids.gbp,
      group: "cash",
      converted_balance: 0,
      unconverted_currencies: ["GBP"],
    });
    expect(byId(ids.old)).toMatchObject({
      group: "archived",
      converted_balance: 10,
    });
  });

  it("converts into a non-EUR display currency through EUR", async () => {
    await seed();

    const res = await api.get("/api/accounts/totals?currency=usd");

    expect(res.status).toBe(200);
    expect(bodyAt(res, "data", "currency")).toBe("USD");
    // (100 EUR → 200 USD) + 100 USD + 200 USD + (-40 EUR → -80 USD)
    expect(bodyAt(res, "data", "net_cash", "total")).toBe(420);
  });

  it("lists computed_balance at stored rates and flags a currency without one", async () => {
    await seed();

    const res = await api.get("/api/accounts");

    expect(res.status).toBe(200);
    const items = bodyAt(res, "data", "items") as Array<{ id: number }>;
    const byId = (id: number | undefined) => items.find((a) => a.id === id);
    // 100 EUR + 100 USD × 0.5 (stored).
    expect(byId(ids.checking)).toMatchObject({
      computed_balance: 150,
      balance_incomplete: false,
      unconverted_currencies: [],
    });
    // A GBP account needs no rate for its own currency.
    expect(byId(ids.gbp)).toMatchObject({
      computed_balance: 50,
      balance_incomplete: false,
    });
  });

  it("flags a partition when no rate is stored at all instead of using a built-in rate", async () => {
    // Regression: with an empty exchange_rates table USD used to convert at
    // the hard-coded 1/1.09, giving 191.74.
    const checking = await addAccount("Checking");
    await addTxn(checking, "100");
    await addTxn(checking, "100", "USD");

    const res = await api.get("/api/accounts");

    expect(res.status).toBe(200);
    const items = bodyAt(res, "data", "items") as Array<{ id: number }>;
    expect(items.find((a) => a.id === checking)).toMatchObject({
      computed_balance: 100,
      balance_incomplete: true,
      unconverted_currencies: ["USD"],
      balance_parts: arrayContaining([
        { currency: "USD", balance: 100 },
      ]),
    });
  });

  it("rejects a malformed currency", async () => {
    const res = await api.get("/api/accounts/totals?currency=euro");
    expect(res.status).toBe(400);
  });
});
