/**
 * Synthetic portfolio, investment, price and currency rows shaped exactly like
 * node-postgres returns them (NUMERIC and BIGINT as strings, DATE/TIMESTAMPTZ
 * as `Date`), for tests that mock `query()` under a repository whose reads
 * are checked by `src/database/rows/portfolio.ts`. Tests run in strict mode,
 * so a fixture must satisfy the row schema; pass `overrides` for the columns
 * a test cares about.
 */
import type {
  AssetPriceHistoryDbRow,
  InvestmentDbRow,
  PortfolioMathTxDbRow,
  PortfolioPerformanceSnapshotDbRow,
  PortfolioTransactionDbRow,
  PortfolioUnitEventDbRow,
  ProviderHealthDbRow,
  SummaryInvestmentDbRow,
  WatchlistDbRow,
} from "../../src/database/rows/portfolio.ts";

const CREATED = new Date("2026-01-01T00:00:00.000Z");

/** An `investments` row (`SELECT *`). */
export function investmentDbRow(
  overrides: Partial<InvestmentDbRow> = {},
): InvestmentDbRow {
  return {
    id: 1,
    name: "Investment",
    symbol: null,
    asset_class: "stocks_etfs",
    currency: "EUR",
    current_price: null,
    interest_rate: null,
    maturity_date: null,
    location: null,
    municipality: null,
    cadastral_income: null,
    municipality_tax_rate: null,
    notes: null,
    is_active: true,
    price_provider: "manual",
    price_provider_id: null,
    price_provider_url: null,
    price_provider_latest_url: null,
    price_provider_latest_path: null,
    price_provider_history_url: null,
    price_provider_history_path: null,
    price_provider_history_ts_path: null,
    price_provider_history_price_path: null,
    price_updated_at: null,
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

/** The portfolio summary's investments read (`COALESCE`d price and rate). */
export function summaryInvestmentDbRow(
  overrides: Partial<SummaryInvestmentDbRow> = {},
): SummaryInvestmentDbRow {
  return {
    ...investmentDbRow(),
    current_price: "0",
    interest_rate: "0",
    ...overrides,
  };
}

/** A raw `portfolio_transactions` row (`SELECT *` / `RETURNING *`). */
export function portfolioTransactionDbRow(
  overrides: Partial<PortfolioTransactionDbRow> = {},
): PortfolioTransactionDbRow {
  return {
    id: 1,
    investment_id: 1,
    type: "buy",
    date: new Date(2026, 0, 15),
    amount: "0.0000",
    units: null,
    price_per_unit: null,
    fees: null,
    taxes: null,
    currency: "EUR",
    fx_rate_to_eur: null,
    note: null,
    is_recurring: false,
    recurrence_interval: null,
    recurrence_end_date: null,
    created_at: CREATED,
    updated_at: CREATED,
    account_id: null,
    dividend_amount_convention: "unknown",
    source_record_hash: null,
    dedup_fingerprint: null,
    dedup_fingerprint_version: null,
    income_recognition_role: "standard",
    ...overrides,
  };
}

/** A `getUnitEventsForInvestment` row. */
export function portfolioUnitEventDbRow(
  overrides: Partial<PortfolioUnitEventDbRow> = {},
): PortfolioUnitEventDbRow {
  return {
    id: "1",
    type: "buy",
    date: "2026-01-15",
    units: "0",
    account_id: null,
    amount: "0",
    fees: null,
    taxes: null,
    fxMultiplier: "1",
    source_account_id: null,
    destination_account_id: null,
    fee_units: "0",
    transfer_id: null,
    currency: "EUR",
    source_record_hash: null,
    adjustment_kind: null,
    basis_policy: null,
    eligible_source_record_hashes: null,
    adjustment_id: null,
    income_recognition_role: "standard",
    ...overrides,
  };
}

/** A `getRowsForPortfolioMath` row. */
export function portfolioMathTxDbRow(
  overrides: Partial<PortfolioMathTxDbRow> = {},
): PortfolioMathTxDbRow {
  const date = overrides.date ?? "2026-01-15";
  return {
    id: "1",
    investment_id: 1,
    type: "buy",
    amount: "0",
    units: "0",
    fees: "0",
    taxes: "0",
    date,
    day: date,
    currency: "EUR",
    fx_rate_to_eur: null,
    account_id: null,
    source_account_id: null,
    destination_account_id: null,
    fee_units: "0",
    source_record_hash: null,
    adjustment_kind: null,
    basis_policy: null,
    eligible_source_record_hashes: null,
    income_recognition_role: "standard",
    ...overrides,
  };
}

/** A `watchlist` row. */
export function watchlistDbRow(
  overrides: Partial<WatchlistDbRow> = {},
): WatchlistDbRow {
  return {
    id: 1,
    name: "Watch",
    symbol: null,
    asset_class: "stocks_etfs",
    target_price: "0",
    currency: "EUR",
    notes: null,
    price_provider_id: null,
    added_price: null,
    created_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

/** A `provider_health` row. */
export function providerHealthDbRow(
  overrides: Partial<ProviderHealthDbRow> = {},
): ProviderHealthDbRow {
  return {
    provider: "provider",
    kind: "quote",
    last_success_at: null,
    last_error_at: null,
    last_error: null,
    consecutive_failures: 0,
    updated_at: CREATED,
    ...overrides,
  };
}

/** An `asset_price_history` row. */
export function assetPriceHistoryDbRow(
  overrides: Partial<AssetPriceHistoryDbRow> = {},
): AssetPriceHistoryDbRow {
  return {
    id: 1,
    investment_id: 1,
    price_date: new Date(2026, 0, 15),
    close_price: "0",
    source: "manual",
    fetched_at: CREATED,
    updated_at: CREATED,
    ...overrides,
  };
}

/** A `portfolio_performance_snapshots` row. */
export function portfolioPerformanceSnapshotDbRow(
  overrides: Partial<PortfolioPerformanceSnapshotDbRow> = {},
): PortfolioPerformanceSnapshotDbRow {
  return {
    id: 1,
    snapshot_date: new Date(2026, 0, 15),
    invested: "0.0000",
    value: "0.0000",
    stocks_etfs_value: "0.0000",
    crypto_value: "0.0000",
    metals_value: "0.0000",
    cash_value: "0.0000",
    gain_loss: "0.0000",
    return_pct: "0.0000",
    inflation_adjusted_value: "0.0000",
    cumulative_inflation: "0.0000",
    real_return_pct: "0.0000",
    stocks_etfs_invested: "0.0000",
    crypto_invested: "0.0000",
    metals_invested: "0.0000",
    currency: "EUR",
    computed_at: CREATED,
    ...overrides,
  };
}

/** A local-midnight `Date`, as node-postgres parses a DATE column. */
export function pgLocalDate(ymd: string): Date {
  const [y = NaN, m = NaN, d = NaN] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** A NUMERIC value as node-postgres returns it (a string), keeping NULL. */
function pgNumericOf(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** A timestamp value as node-postgres returns it (a `Date`). */
function pgTimestampOf(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * Re-shape a formatted investment fixture (numbers, string dates) into the
 * pg row the summary read returns: NUMERIC as strings, timestamps as `Date`,
 * `price_provider` defaulting to its NOT NULL `'manual'`.
 */
export function toPgSummaryInvestmentRow(
  row: Record<string, unknown>,
): SummaryInvestmentDbRow {
  return summaryInvestmentDbRow({
    ...(row as Partial<SummaryInvestmentDbRow>),
    current_price: pgNumericOf(row.current_price) ?? "0",
    interest_rate: pgNumericOf(row.interest_rate) ?? "0",
    cadastral_income: pgNumericOf(row.cadastral_income),
    municipality_tax_rate: pgNumericOf(row.municipality_tax_rate),
    maturity_date:
      row.maturity_date == null ? null : pgLocalDate(String(row.maturity_date)),
    price_provider:
      typeof row.price_provider === "string" ? row.price_provider : "manual",
    price_updated_at:
      row.price_updated_at == null ? null : pgTimestampOf(row.price_updated_at),
    created_at: pgTimestampOf(row.created_at ?? CREATED),
    updated_at: pgTimestampOf(row.updated_at ?? CREATED),
  });
}

/**
 * Re-shape a formatted portfolio-transaction fixture into a
 * `getRowsForPortfolioMath` row (BIGINT id and NUMERIC columns as strings).
 */
export function toPgMathTxRow(
  row: Record<string, unknown>,
): PortfolioMathTxDbRow {
  const date = String(row.date ?? row.day ?? "2026-01-15");
  return portfolioMathTxDbRow({
    ...(row as Partial<PortfolioMathTxDbRow>),
    id: String(row.id ?? 1),
    amount: pgNumericOf(row.amount) ?? "0",
    units: pgNumericOf(row.units) ?? "0",
    fees: pgNumericOf(row.fees) ?? "0",
    taxes: pgNumericOf(row.taxes) ?? "0",
    fee_units: pgNumericOf(row.fee_units) ?? "0",
    fx_rate_to_eur: pgNumericOf(row.fx_rate_to_eur),
    date,
    day: typeof row.day === "string" ? row.day : date,
  });
}
