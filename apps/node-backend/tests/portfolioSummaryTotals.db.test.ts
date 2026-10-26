/**
 * GET /api/info/portfolio-summary against real PostgreSQL: the per-asset-class
 * and per-asset-group totals the asset pages show (ADR-216), and the
 * per-holding display figures they read (monthlyRent, feesAndTaxes,
 * propertyReturn). Every expected value is hand-computed from the seeded
 * transactions; amounts are EUR unless a test says otherwise.
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
import { addDaysYmd, todayAppDateString } from "../src/lib/timezone.ts";
import { invalidatePortfolioCaches } from "../src/services/info/cache.ts";
import { clearMemoryCache } from "../src/services/currency/currencyConversionService.ts";
import { routeAgent } from "./helpers/routeApp.ts";
import { bodyAt } from "./helpers/responseBody.ts";
import portfolioSummaryRouter from "../src/routes/info/portfolioSummary.ts";
import { must } from "./helpers/must.ts";

const describeDb = hasTestDatabase() ? describe : describe.skip;

interface InvestmentSeed {
  name: string;
  assetClass: string;
  price?: number;
  interestRate?: number;
  isActive?: boolean;
  currency?: string;
}

async function investment({
  name,
  assetClass,
  price = 0,
  interestRate = 0,
  isActive = true,
  currency = "EUR",
}: InvestmentSeed) {
  const { rows } = await must(getTestPool(), "test pool").query<{ id: number }>(
    `INSERT INTO investments (name, symbol, asset_class, currency, current_price, interest_rate, is_active)
     VALUES ($1, $1, $2, $6, $3, $4, $5) RETURNING id`,
    [name, assetClass, price, interestRate, isActive, currency],
  );
  return must(rows[0], "rows[0]").id;
}

async function brokerAccount(name: string) {
  const { rows } = await must(getTestPool(), "test pool").query<{ id: number }>(
    `INSERT INTO accounts (name, type, currency)
     VALUES ($1, 'brokerage'::account_type, 'EUR') RETURNING id`,
    [name],
  );
  return must(rows[0], "rows[0]").id;
}

async function txn(
  investmentId: number,
  type: string,
  date: string,
  amount: number,
  {
    units = null,
    currency = "EUR",
    accountId = null,
  }: {
    units?: number | null;
    currency?: string;
    accountId?: number | null;
  } = {},
) {
  await must(getTestPool(), "test pool").query(
    `INSERT INTO portfolio_transactions (investment_id, type, date, amount, units, currency, account_id)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7)`,
    [investmentId, type, date, amount, units, currency, accountId],
  );
}

async function setRate(code: string, rateToEur: string, rateDate: string) {
  await must(getTestPool(), "test pool").query(
    `INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest)
     VALUES ($1, $2, $3, true)`,
    [code, rateToEur, rateDate],
  );
}

type Totals = Record<string, unknown>;
type Response = Parameters<typeof bodyAt>[0];

function group(body: Response, key: string): Totals {
  const groups = bodyAt(body, "data", "byAssetGroup") as Totals[];
  const found = groups.find((entry) => entry.group === key);
  if (!found) throw new Error(`missing group ${key}`);
  return found;
}

function assetClass(body: Response, key: string): Totals | undefined {
  const classes = bodyAt(body, "data", "byAssetClass") as Totals[];
  return classes.find((entry) => entry.assetClass === key);
}

function summary(body: Response, name: string): Totals {
  const rows = bodyAt(body, "data", "summaries") as Totals[];
  const found = rows.find((row) => row.name === name);
  if (!found) throw new Error(`missing summary ${name}`);
  return found;
}

describeDb("GET /api/info/portfolio-summary asset totals (real DB)", () => {
  const api = routeAgent(portfolioSummaryRouter, { mountPath: "/api/info" });
  const today = todayAppDateString();

  beforeAll(async () => {
    await acquireDbSuiteLock();
  });

  beforeEach(async () => {
    const pool = must(getTestPool(), "test pool");
    await pool.query("DELETE FROM portfolio_transactions");
    await pool.query("DELETE FROM investments");
    await pool.query(
      "DELETE FROM accounts WHERE name LIKE 'Synthetic broker%'",
    );
    await pool.query("DELETE FROM exchange_rates");
    await pool.query(
      "DELETE FROM user_settings WHERE key = 'cost_basis_method'",
    );
    invalidatePortfolioCaches();
    clearMemoryCache();
  });

  afterAll(async () => {
    const pool = must(getTestPool(), "test pool");
    await pool.query("DELETE FROM portfolio_transactions");
    await pool.query("DELETE FROM investments");
    await pool.query(
      "DELETE FROM accounts WHERE name LIKE 'Synthetic broker%'",
    );
    await pool.query("DELETE FROM exchange_rates");
    invalidatePortfolioCaches();
    await releaseDbSuiteLock();
    await closeTestPool();
    await closePool();
  });

  async function seedPortfolio() {
    // Stock: 10 units for 100, price 15 → value 150, unrealized 50;
    // dividend 5 → gainLoss 55.
    const stock = await investment({
      name: "Synthetic stock",
      assetClass: "stock",
      price: 15,
    });
    await txn(stock, "buy", "2026-01-02", 100, { units: 10 });
    await txn(stock, "dividend", "2026-02-01", 5);
    // ETF: 5 units for 50 (avg 10), fee 2, sell 2 units for 50 → realized
    // 50 − 20 = 30; 3 units at 20 → value 60, unrealized 30; gainLoss
    // 30 + 30 − 2 = 58.
    const etf = await investment({
      name: "Synthetic ETF",
      assetClass: "etf",
      price: 20,
    });
    await txn(etf, "buy", "2026-01-03", 50, { units: 5 });
    await txn(etf, "fee", "2026-01-04", 2);
    await txn(etf, "sell", "2026-02-02", 50, { units: 2 });
    // Property: bought 100 000, appreciation 5 000, rent 800 EUR then
    // 900 USD at 0.9 = 810, fee 100, tax 50.
    await setRate("USD", "0.9", "2026-01-01");
    const property = await investment({
      name: "Synthetic property",
      assetClass: "real_estate",
    });
    await txn(property, "buy", "2026-01-05", 100000);
    await txn(property, "appreciation", "2026-02-01", 5000);
    await txn(property, "rent_income", "2026-02-01", 800);
    await txn(property, "rent_income", "2026-03-01", 900, { currency: "USD" });
    await txn(property, "fee", "2026-02-01", 100);
    await txn(property, "tax", "2026-02-01", 50);
    // Savings 1 000 at 2 %, interest paid today → nothing accrued yet.
    const savings = await investment({
      name: "Synthetic savings",
      assetClass: "savings",
      interestRate: 2,
    });
    await txn(savings, "buy", addDaysYmd(today, -200), 1000);
    await txn(savings, "interest", today, 10);
    // Bond 3 000 at 4 % for 73 days → accrued 3 000 × 0.04 × 73/365 = 24.
    const bond = await investment({
      name: "Synthetic bond",
      assetClass: "bond",
      interestRate: 4,
    });
    await txn(bond, "buy", addDaysYmd(today, -73), 3000);
    // Archived stock: 1 unit for 5 at price 10.
    const archived = await investment({
      name: "Archived stock",
      assetClass: "stock",
      price: 10,
      isActive: false,
    });
    await txn(archived, "buy", "2026-01-02", 5, { units: 1 });
  }

  it("totals each asset page group from the active holdings", async () => {
    await seedPortfolio();

    const res = await api.get("/api/info/portfolio-summary?currency=EUR");

    expect(res.status).toBe(200);
    expect(
      (bodyAt(res, "data", "byAssetGroup") as Totals[]).map(
        (entry) => entry.group,
      ),
    ).toEqual([
      "stocks_etfs",
      "crypto",
      "metals",
      "real_estate",
      "savings_bonds",
    ]);
    expect(group(res, "stocks_etfs")).toMatchObject({
      assetClasses: ["stock", "etf"],
      holdingCount: 2,
      totalPortfolioValue: 210,
      totalInvested: 150,
      totalRealizedGain: 30,
      totalUnrealizedGain: 80,
      totalDividends: 5,
      totalIncome: 5,
      totalFees: 2,
      totalTaxes: 0,
      totalFeesAndTaxes: 2,
      totalGainLoss: 113,
      // Crypto-style net return leaves out every income: 50 + 58.
      netReturnExcludingIncome: 108,
      // Stocks/Metals add the dividends back: 108 + 5.
      netReturnWithDividends: 113,
    });
    expect(group(res, "crypto")).toMatchObject({
      holdingCount: 0,
      totalPortfolioValue: 0,
      netReturnWithDividends: 0,
    });
    expect(group(res, "real_estate")).toMatchObject({
      holdingCount: 1,
      totalPortfolioValue: 105000,
      totalInvested: 100000,
      totalAppreciation: 5000,
      totalIncome: 1610,
      totalFees: 100,
      totalTaxes: 50,
      totalFeesAndTaxes: 150,
      // 5 000 + 1 610 − 100 − 50.
      totalPropertyReturn: 6460,
      // Latest rent: 900 USD at the latest stored rate 0.9.
      estimatedMonthlyRent: 810,
      monthlyRentRateMissing: false,
    });
    const savings = group(res, "savings_bonds");
    expect(savings).toMatchObject({
      holdingCount: 2,
      totalPortfolioValue: 4024,
      totalIncome: 10,
      // 1 000 × 2 % + 3 000 × 4 %.
      totalProjectedAnnualInterest: 140,
      totalAccruedInterest: 24,
    });
    // (2 × 1 000 + 4 × 3 024) / 4 024.
    expect(savings.valueWeightedInterestRate).toBeCloseTo(14096 / 4024, 6);

    expect(summary(res, "Synthetic property")).toMatchObject({
      monthlyRent: 810,
      feesAndTaxes: 150,
      propertyReturn: 6460,
    });
    expect(assetClass(res, "stock")).toMatchObject({
      holdingCount: 1,
      totalPortfolioValue: 150,
    });
    expect(
      (bodyAt(res, "data", "byAssetClass") as Totals[]).map(
        (entry) => entry.assetClass,
      ),
    ).toEqual(["stock", "etf", "real_estate", "savings", "bond"]);
  });

  it("includes archived holdings in the totals of an active=false request", async () => {
    await seedPortfolio();

    const res = await api.get(
      "/api/info/portfolio-summary?currency=EUR&active=false",
    );

    expect(res.status).toBe(200);
    // The archived stock adds 1 unit × 10.
    expect(group(res, "stocks_etfs")).toMatchObject({
      holdingCount: 3,
      totalPortfolioValue: 220,
      totalInvested: 155,
    });
    expect(assetClass(res, "stock")).toMatchObject({
      holdingCount: 2,
      totalPortfolioValue: 160,
    });
  });

  it("flags rent in a currency without a rate instead of adding it 1:1", async () => {
    const property = await investment({
      name: "Synthetic property",
      assetClass: "real_estate",
    });
    await txn(property, "buy", "2026-01-05", 100000);
    await txn(property, "rent_income", "2026-02-01", 1000, {
      currency: "ARS",
    });
    const euroProperty = await investment({
      name: "Euro property",
      assetClass: "real_estate",
    });
    await txn(euroProperty, "buy", "2026-01-05", 50000);
    await txn(euroProperty, "rent_income", "2026-02-01", 700);

    const res = await api.get("/api/info/portfolio-summary?currency=EUR");

    expect(res.status).toBe(200);
    expect(summary(res, "Synthetic property").monthlyRent).toBeNull();
    expect(summary(res, "Euro property").monthlyRent).toBe(700);
    expect(group(res, "real_estate")).toMatchObject({
      estimatedMonthlyRent: 700,
      monthlyRentRateMissing: true,
    });
  });

  it("totals each broker account on the server for the broker filter", async () => {
    const brokerA = await brokerAccount("Synthetic broker A");
    const brokerB = await brokerAccount("Synthetic broker B");
    // Fund: 10 units for 100 at A and 5 units for 60 at B, price 15 →
    // A value 150 (gain 50), B value 75 (gain 15).
    const fund = await investment({
      name: "Synthetic fund",
      assetClass: "etf",
      price: 15,
    });
    await txn(fund, "buy", "2026-01-02", 100, {
      units: 10,
      accountId: brokerA,
    });
    await txn(fund, "buy", "2026-01-03", 60, { units: 5, accountId: brokerB });
    // Stock: 2 units for 20 at A, price 12 → value 24 (gain 4).
    const stock = await investment({
      name: "Synthetic stock",
      assetClass: "stock",
      price: 12,
    });
    await txn(stock, "buy", "2026-01-04", 20, { units: 2, accountId: brokerA });
    // Unassigned: 1 unit for 8, price 10 → value 10 (gain 2).
    const loose = await investment({
      name: "Unassigned stock",
      assetClass: "stock",
      price: 10,
    });
    await txn(loose, "buy", "2026-01-05", 8, { units: 1 });

    const res = await api.get("/api/info/portfolio-summary?currency=EUR");

    expect(res.status).toBe(200);
    const accountRow = (rows: Totals[], id: number | null) =>
      rows.find((row) => row.account_id === id);
    const fundTotals = summary(res, "Synthetic fund").accountTotals as Totals[];
    expect(accountRow(fundTotals, brokerA)).toMatchObject({
      assignment: "account",
      currentValue: 150,
      totalInvested: 100,
      gainLoss: 50,
      oversold: false,
    });
    expect(accountRow(fundTotals, brokerB)).toMatchObject({
      currentValue: 75,
      totalInvested: 60,
      gainLoss: 15,
    });
    // Portfolio-wide subtotal per broker: fund + stock at A.
    const totals = bodyAt(res, "data", "accountTotals") as Totals[];
    expect(accountRow(totals, brokerA)).toMatchObject({
      currentValue: 174,
      totalInvested: 120,
      gainLoss: 54,
    });
    expect(accountRow(totals, brokerB)).toMatchObject({
      currentValue: 75,
      gainLoss: 15,
    });
    expect(accountRow(totals, null)).toMatchObject({
      assignment: "unassigned",
      currentValue: 10,
      totalInvested: 8,
      gainLoss: 2,
    });
    expect(totals.map((row) => row.currentValue)).toEqual([174, 75, 10]);
  });

  it("flags a holding whose currency has no stored rate instead of using a built-in rate", async () => {
    // USD is in the built-in constants, but nothing is stored for it.
    const usd = await investment({
      name: "USD stock",
      assetClass: "stock",
      price: 20,
      currency: "USD",
    });
    await txn(usd, "buy", "2026-01-02", 100, { units: 10, currency: "USD" });
    const archivedUsd = await investment({
      name: "Archived USD stock",
      assetClass: "stock",
      price: 30,
      currency: "USD",
      isActive: false,
    });
    await txn(archivedUsd, "buy", "2026-01-02", 50, {
      units: 2,
      currency: "USD",
    });

    const res = await api.get("/api/info/portfolio-summary?currency=EUR");

    expect(res.status).toBe(200);
    // 10 units × 20 stays unconverted and is flagged, never × 1/1.09.
    expect(summary(res, "USD stock")).toMatchObject({
      currentValue: 200,
      usedFallbackRate: true,
    });
    expect(bodyAt(res, "data", "totals", "usedFallbackRate")).toBe(true);

    const all = await api.get(
      "/api/info/portfolio-summary?currency=EUR&active=false",
    );
    expect(all.status).toBe(200);
    const archived = (
      bodyAt(all, "data", "archivedPresentation") as Totals[]
    ).find((row) => row.name === "Archived USD stock");
    expect(archived).toMatchObject({
      currentValue: 60,
      usedFallbackRate: true,
    });
  });

  it("converts holdings and archived views at the stored rate", async () => {
    await setRate("USD", "0.8", "2026-01-01");
    const usd = await investment({
      name: "USD stock",
      assetClass: "stock",
      price: 20,
      currency: "USD",
    });
    await txn(usd, "buy", "2026-01-02", 100, { units: 10, currency: "USD" });
    const archivedUsd = await investment({
      name: "Archived USD stock",
      assetClass: "stock",
      price: 30,
      currency: "USD",
      isActive: false,
    });
    await txn(archivedUsd, "buy", "2026-01-02", 50, {
      units: 2,
      currency: "USD",
    });

    const res = await api.get(
      "/api/info/portfolio-summary?currency=EUR&active=false",
    );

    expect(res.status).toBe(200);
    // 200 USD × 0.8 and 60 USD × 0.8.
    expect(summary(res, "USD stock")).toMatchObject({
      currentValue: 160,
      usedFallbackRate: false,
    });
    const archived = (
      bodyAt(res, "data", "archivedPresentation") as Totals[]
    ).find((row) => row.name === "Archived USD stock");
    expect(archived).toMatchObject({ currentValue: 48 });
    expect(archived?.usedFallbackRate).toBeUndefined();
  });
});
