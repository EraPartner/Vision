import { z } from "zod";

import { ASSET_CLASSES } from "../assetClasses.ts";
import {
  PORTFOLIO_INCOME_RECOGNITION_ROLES,
  PORTFOLIO_TXN_TYPES,
} from "../portfolioTxnTypes.ts";
import { PORTFOLIO_RECURRENCE_INTERVALS } from "../recurrence.ts";
import { IdSchema, NumericSchema, WireLinkSchema } from "./common.ts";

/*
 * Wire contracts for the portfolio reads: /api/investments (holdings,
 * portfolio transactions, providers, price history, exposure, broker retag)
 * and the /api/info portfolio summary and performance bodies. Fields the
 * backend always emits are required; objects stay loose so an added column
 * does not break a screen.
 */

const CountSchema = z.number().int().nonnegative();
/** A 'YYYY-MM-DD' calendar day (DATE columns go through toWireDate/toYmd). */
const DayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** An ISO timestamp (a TIMESTAMPTZ `Date` after JSON serialization). */
const TimestampSchema = z.string();

/**
 * One `investments` row after `mapInvestmentRow` (investmentRepository): the
 * four NUMERIC columns are JSON numbers, `maturity_date` is a calendar day.
 * `show_in_ticker` comes from the joined reads only; a bare `RETURNING *`
 * (create, plain update) omits it.
 */
export const InvestmentSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  symbol: z.string().nullable(),
  asset_class: z.enum(ASSET_CLASSES),
  currency: z.string(),
  current_price: z.number().nullable(),
  interest_rate: z.number().nullable(),
  maturity_date: DayStringSchema.nullable(),
  location: z.string().nullable(),
  municipality: z.string().nullable(),
  cadastral_income: z.number().nullable(),
  municipality_tax_rate: z.number().nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  price_provider: z.string(),
  price_provider_id: z.string().nullable(),
  price_provider_url: z.string().nullable(),
  price_provider_latest_url: z.string().nullable(),
  price_provider_latest_path: z.string().nullable(),
  price_provider_history_url: z.string().nullable(),
  price_provider_history_path: z.string().nullable(),
  price_provider_history_ts_path: z.string().nullable(),
  price_provider_history_price_path: z.string().nullable(),
  price_updated_at: TimestampSchema.nullable(),
  show_in_ticker: z.boolean().optional(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});

/** `GET /api/investments` — always paginated, `links: []`. */
export const InvestmentListSchema = z.looseObject({
  items: z.array(InvestmentSchema),
  total: CountSchema,
  limit: z.number().int().positive(),
  offset: CountSchema,
  links: z.array(WireLinkSchema),
});

/** `GET /api/investments/providers` — the static SUPPORTED_PROVIDERS list. */
export const PriceProviderListSchema = z.looseObject({
  providers: z.array(
    z.looseObject({
      key: z.string(),
      name: z.string(),
      description: z.string(),
    }),
  ),
});

/**
 * `POST /api/investments/refresh-prices`. With nothing to refresh the route
 * answers only `{ updated: 0, message }`; otherwise the counts and per-id maps.
 * A provider can answer a null price, which JSON keeps as null.
 */
export const RefreshPricesResultSchema = z.looseObject({
  updated: CountSchema,
  message: z.string().optional(),
  total: CountSchema.optional(),
  prices: z.record(z.string(), z.number().nullable()).optional(),
  priceSources: z
    .record(
      z.string(),
      z.enum(["live", "close", "cached", "historical_fallback"]),
    )
    .optional(),
});

/** `GET /api/investments/:id/price-history`. */
export const InvestmentPriceHistorySchema = z.looseObject({
  investment_id: IdSchema,
  provider: z.string(),
  points: z.array(
    z.looseObject({ timestampMs: z.number(), price: z.number() }),
  ),
});

/**
 * One `portfolio_transactions` row after `mapPortfolioTxRow`: NUMERIC columns
 * are JSON numbers, both DATE columns calendar days, `import_batch_id` (BIGINT)
 * stays a string. `income_recognition_role` defaults to "standard".
 */
export const PortfolioTransactionSchema = z.looseObject({
  id: IdSchema,
  investment_id: IdSchema,
  type: z.enum(PORTFOLIO_TXN_TYPES),
  date: DayStringSchema,
  amount: z.number(),
  units: z.number().nullable(),
  price_per_unit: z.number().nullable(),
  fees: z.number().nullable(),
  taxes: z.number().nullable(),
  dividend_amount_convention: z.enum(["gross", "net", "unknown"]),
  income_recognition_role: z.enum(PORTFOLIO_INCOME_RECOGNITION_ROLES),
  currency: z.string(),
  fx_rate_to_eur: z.number().nullable(),
  note: z.string().nullable(),
  is_recurring: z.boolean(),
  recurrence_interval: z.enum(PORTFOLIO_RECURRENCE_INTERVALS).nullable(),
  recurrence_end_date: DayStringSchema.nullable(),
  account_id: IdSchema.nullable(),
  import_batch_id: z.string().regex(/^\d+$/).nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
});

/**
 * `GET /api/investments/:id/transactions` and the bulk
 * `GET /api/investments/transactions`. The bulk read's `limit` is the item
 * count when the caller set none, which can be 0.
 */
export const PortfolioTransactionListSchema = z.looseObject({
  items: z.array(PortfolioTransactionSchema),
  total: CountSchema,
  limit: CountSchema,
  offset: CountSchema,
  links: z.array(WireLinkSchema),
});

/** `PUT /api/investments/transactions/broker` — portfolioBrokerRetagService.mapReceipt. */
export const PortfolioBrokerRetagReceiptSchema = z.looseObject({
  receipt_id: IdSchema,
  idempotency_key: z.string(),
  from_account_id: IdSchema.nullable(),
  to_account_id: IdSchema.nullable(),
  transaction_ids: z.array(IdSchema),
  previous_assignments: z.array(
    z.looseObject({
      transaction_id: IdSchema,
      account_id: IdSchema.nullable(),
    }),
  ),
  selected_count: CountSchema,
  changed_count: CountSchema,
  created_at: TimestampSchema,
  replayed: z.boolean(),
});

const ExposureContributionSchema = z.looseObject({
  sourceType: z.enum(["direct", "fund"]),
  investmentId: IdSchema,
  investmentName: z.string(),
  sourceFundName: z.string().nullable(),
  amount: z.number(),
  sourceAsOfDate: z.string().nullable(),
  stale: z.boolean(),
});

const ExposureDimensionSchema = z.looseObject({
  rows: z.array(
    z.looseObject({
      id: z.string(),
      label: z.string(),
      amount: z.number(),
      weightPercent: z.number(),
      contributions: z.array(ExposureContributionSchema),
    }),
  ),
  classifiedValue: z.number(),
  classifiedWeightPercent: z.number(),
  unclassifiedValue: z.number(),
  unclassifiedWeightPercent: z.number(),
});

/** `GET /api/investments/exposure` — portfolioExposureService.aggregatePortfolioExposure. */
export const PortfolioExposureSchema = z.looseObject({
  currency: z.string(),
  computedAt: z.string(),
  totalValue: z.number(),
  uncoveredValue: z.number(),
  uncoveredWeightPercent: z.number(),
  coveredCashValue: z.number(),
  coveredCashWeightPercent: z.number(),
  fundSources: z.array(
    z.looseObject({
      investmentId: IdSchema,
      investmentName: z.string(),
      asOfDate: z.string(),
      evaluatedAt: z.string(),
      ageDays: z.number(),
      maximumAgeDays: z.number(),
      stale: z.boolean(),
      coverageStatus: z.string(),
    }),
  ),
  issuer: ExposureDimensionSchema,
  sector: ExposureDimensionSchema,
  issuerCountry: ExposureDimensionSchema,
  warnings: z.array(z.looseObject({ code: z.string() })),
  scopeNotes: z.array(z.string()),
});

// ── /api/info/portfolio-summary ─────────────────────────────────────────────

/** portfolioSummaryService.aggregateTotals. */
export const PortfolioSummaryTotalsSchema = z.looseObject({
  totalPortfolioValue: z.number(),
  totalInvested: z.number(),
  totalGainLoss: z.number(),
  totalRealizedGain: z.number(),
  totalUnrealizedGain: z.number(),
  totalGain: z.number(),
  totalIncome: z.number(),
  totalDividends: z.number(),
  totalInKindIncome: z.number(),
  totalFees: z.number(),
  totalTaxes: z.number(),
  totalAssetGain: z.number(),
  totalFxGain: z.number(),
  totalReturnPct: z.number(),
  usedFallbackRate: z.boolean(),
});

/** portfolioSummaryService.aggregateByAccount — one rounded partition row. */
export const PortfolioSummaryByAccountSchema = z.looseObject({
  account_id: IdSchema.nullable(),
  assignment: z.enum(["account", "unassigned"]),
  contribution_kind: z.enum(["position", "non_position"]),
  oversold: z.boolean(),
  currentValue: z.number(),
  totalInvested: z.number(),
  realizedGain: z.number(),
  unrealizedGain: z.number(),
  gainLoss: z.number(),
});

/**
 * One `summaries[]` entry (portfolioSummaryService.buildInvestmentSummary).
 * The identity passthrough fields come from a raw `SELECT i.*`, NOT through
 * mapInvestmentRow: `cadastral_income` / `municipality_tax_rate` are NUMERIC
 * strings and `maturity_date` is a serialized `Date` (an ISO timestamp).
 */
export const PortfolioSummaryItemSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  symbol: z.string().nullable(),
  asset_class: z.string(),
  assetClass: z.string(),
  is_active: z.boolean(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  notes: z.string().nullable(),
  location: z.string().nullable(),
  municipality: z.string().nullable(),
  cadastral_income: NumericSchema.nullable(),
  municipality_tax_rate: NumericSchema.nullable(),
  maturity_date: z.string().nullable(),
  maturityDate: z.string().nullable(),
  price_provider: z.string(),
  price_provider_id: z.string().nullable(),
  price_updated_at: TimestampSchema.nullable(),
  currency: z.string(),
  originalCurrency: z.string(),
  totalUnits: z.number(),
  currentPrice: z.number(),
  current_price: z.number(),
  interestRate: z.number(),
  interest_rate: z.number(),
  totalInvested: z.number(),
  totalBuyCost: z.number(),
  totalSellProceeds: z.number(),
  currentValue: z.number(),
  totalFees: z.number(),
  totalTaxes: z.number(),
  totalDividends: z.number(),
  totalIncome: z.number(),
  totalInKindIncome: z.number(),
  avgCostBasis: z.number(),
  realizedGain: z.number(),
  unrealizedGain: z.number(),
  totalGain: z.number(),
  gainLoss: z.number(),
  gainLossPercent: z.number(),
  assetGain: z.number(),
  fxGain: z.number(),
  nativeCurrentValue: z.number(),
  usedFallbackRate: z.boolean(),
  accruedInterest: z.number(),
  projectedAnnualInterest: z.number(),
  totalAppreciation: z.number(),
  fullyAssigned: z.boolean(),
  oversold: z.boolean(),
  byAccount: z.array(PortfolioSummaryByAccountSchema),
});

/** `GET /api/info/portfolio-summary` — portfolioSummaryService.getPortfolioSummary. */
export const PortfolioSummarySchema = z.looseObject({
  currency: z.string(),
  computed_at: z.string(),
  totals: PortfolioSummaryTotalsSchema,
  summaries: z.array(PortfolioSummaryItemSchema),
  byAccount: z.array(PortfolioSummaryByAccountSchema),
  archivedInKindIncome: z.array(
    z.looseObject({ id: IdSchema, totalInKindIncome: z.number() }),
  ),
  brokerageCashFees: z.looseObject({
    total: z.number(),
    gainAfterFees: z.number(),
    usedFallbackRate: z.boolean(),
    byAccount: z.array(
      z.looseObject({ account_id: IdSchema, total: z.number() }),
    ),
  }),
});

// ── /api/info/portfolio-performance ─────────────────────────────────────────

/** performanceHelpers.mapPortfolioPerformanceSnapshot plus `is_provisional`. */
const PerformanceSnapshotSchema = z.looseObject({
  date: DayStringSchema,
  invested: z.number(),
  value: z.number(),
  stocks_etfs_value: z.number(),
  crypto_value: z.number(),
  metals_value: z.number(),
  stocks_etfs_invested: z.number(),
  crypto_invested: z.number(),
  metals_invested: z.number(),
  inflation_adjusted_value: z.number(),
  gain_loss: z.number(),
  return_pct: z.number(),
  is_provisional: z.boolean(),
  value_fx_neutral: z.number().optional(),
});

/** `GET /api/info/portfolio-performance` — buildPortfolioPerformancePayload. */
export const PortfolioPerformanceSchema = z.looseObject({
  currency: z.string(),
  start_date: DayStringSchema,
  end_date: DayStringSchema,
  snapshots: z.array(PerformanceSnapshotSchema),
  metrics: z
    .looseObject({
      currentValue: z.number(),
      totalInvested: z.number(),
      totalGainLoss: z.number(),
      totalReturnPct: z.number(),
      annualizedReturn: z.number(),
      realReturnPct: z.number(),
      cumulativeInflation: z.number(),
    })
    .nullable(),
  heatmap: z.looseObject({
    years: z.array(z.number().int()),
    data: z.record(z.string(), z.array(z.number().nullable())),
    maxAbsPct: z.number(),
  }),
  breakdownSummary: z.array(
    z.looseObject({
      id: IdSchema,
      name: z.string(),
      symbol: z.string().nullable(),
      assetClass: z.string(),
      currency: z.string(),
      currentValue: z.number(),
      totalInvested: z.number(),
      gainLoss: z.number(),
      gainLossPercent: z.number(),
      assetGain: z.number(),
      fxGain: z.number(),
      nativeCurrentValue: z.number(),
      usedFallbackRate: z.boolean(),
    }),
  ),
  totals: PortfolioSummaryTotalsSchema,
});

const BrokerSeriesSchema = z.looseObject({
  accountKey: z.string(),
  accountId: IdSchema.nullable(),
  accountName: z.string(),
  assignment: z.enum(["account", "unassigned"]),
});

/** `GET /api/info/portfolio-performance/by-broker` (routes/info/performance.ts). */
export const BrokerPortfolioPerformanceSchema = z.looseObject({
  currency: z.string(),
  startDate: DayStringSchema,
  endDate: DayStringSchema,
  dates: z.array(DayStringSchema),
  series: z.array(BrokerSeriesSchema),
  rows: z.array(
    BrokerSeriesSchema.extend({
      date: DayStringSchema,
      currency: z.string(),
      value: z.number(),
      invested: z.number(),
      gainLoss: z.number(),
      computedAt: TimestampSchema,
    }),
  ),
});
