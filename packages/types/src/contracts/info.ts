import { z } from "zod";

import { IdSchema } from "./common.ts";

/*
 * Wire contracts for the /api/info reads that are not portfolio-specific
 * (those live in portfolio.ts): metadata lists, recurring patterns, the
 * insights digest, deduction candidates, net worth and exchange rates.
 */

const CountSchema = z.number().int().nonnegative();
const DayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `GET /api/info/supported-adapters` — the adapter registry, `{items, total}`. */
export const SupportedAdapterListSchema = z.looseObject({
  items: z.array(z.looseObject({ key: z.string(), name: z.string() })),
  total: CountSchema,
});

/** `GET /api/info/banks` — account names with activity, `{items, total}`. */
export const BankNameListSchema = z.looseObject({
  items: z.array(z.string()),
  total: CountSchema,
});

/** `GET /api/info/transaction-count`. */
export const InfoTransactionCountSchema = z.looseObject({
  total_transactions: CountSchema,
});

/** `GET /api/info/recurring-patterns` — recurringDetectionService.RecurringPattern. */
export const RecurringPatternListSchema = z.looseObject({
  patterns: z.array(
    z.looseObject({
      recipientId: IdSchema.nullable(),
      recipientName: z.string(),
      direction: z.enum(["income", "expense"]),
      detectedPattern: z.string(),
      intervalDays: z.number(),
      consistency: z.number(),
      occurrences: CountSchema,
      averageAmount: z.number(),
      latestAmount: z.number(),
      currency: z.string(),
      categoryId: IdSchema.nullable(),
      categoryName: z.string().nullable(),
      bankAccount: z.string().nullable(),
      accountId: IdSchema.nullable(),
      firstSeen: z.string().nullable(),
      lastSeen: z.string().nullable(),
      predictedNext: z.string(),
      amountChanges: z.array(
        z.looseObject({
          date: z.string(),
          previousAmount: z.number(),
          newAmount: z.number(),
          percentChange: z.number(),
          direction: z.string(),
        }),
      ),
      isAlreadyPlanned: z.boolean(),
      confidence: z.number(),
    }),
  ),
  total: CountSchema,
});

/** `GET /api/info/insights-digest` — insightsDigestService.getInsightsDigest. */
export const InsightsDigestSchema = z.looseObject({
  subscriptionCreep: z.looseObject({
    new: z.array(
      z.looseObject({
        recipientId: IdSchema.nullable(),
        recipientName: z.string(),
        findingType: z.literal("new"),
        latestAmount: z.number(),
        currency: z.string(),
        detectedPattern: z.string(),
        intervalDays: z.number(),
        predictedNext: z.string(),
        confidence: z.number(),
      }),
    ),
    priceChanges: z.array(
      z.looseObject({
        recipientId: IdSchema.nullable(),
        recipientName: z.string(),
        findingType: z.literal("priceChange"),
        previousAmount: z.number(),
        newAmount: z.number(),
        percentChange: z.number(),
        direction: z.string(),
        currency: z.string(),
        confidence: z.number(),
      }),
    ),
  }),
  categoryOutliers: z.array(
    z.looseObject({
      categoryId: IdSchema,
      categoryName: z.string().nullable(),
      monthKey: z.string(),
      comparisonEndDay: z.number(),
      currentAmount: z.number(),
      baselineMedian: z.number(),
      deviation: z.number(),
      direction: z.string(),
    }),
  ),
  cashForecast: z
    .looseObject({
      month: z.string(),
      currency: z.string(),
      monthEndNetCashflow: z.number(),
      monthEndNetCashflowLow: z.number().nullable(),
      monthEndNetCashflowHigh: z.number().nullable(),
      movedSignificantly: z.boolean(),
      prominence: z.string(),
      methodId: z.string(),
    })
    .nullable(),
});

/** `GET /api/info/insights-count` — insightsDigestService.getInsightsCount. */
export const InsightsCountSchema = z.looseObject({
  count: CountSchema.nullable(),
  status: z.enum(["ready", "pending", "unavailable"]),
  computed_at: z.string().nullable(),
});

/** `GET /api/info/deduction-candidates` — deductionCandidatesService. */
export const DeductionCandidatesSchema = z.looseObject({
  year: z.number().int(),
  from: DayStringSchema,
  to: DayStringSchema,
  currency: z.string(),
  byDeductionType: z.array(
    z.looseObject({
      deductionType: z.string(),
      total: z.number(),
      categoryCount: CountSchema,
      categories: z.array(
        z.looseObject({
          category: z.string(),
          total: z.number(),
          count: CountSchema,
        }),
      ),
    }),
  ),
});

const NetWorthPointSchema = z.looseObject({
  liquid: z.number(),
  liabilities: z.number(),
  investments: z.number(),
  netWorth: z.number(),
});

/**
 * `GET /api/info/net-worth` — infoRepositoryNetWorth.getNetWorthFromSnapshots.
 * The three `snapshots*` pagination facts are set only when the request
 * supplied limit/offset.
 */
export const NetWorthSchema = z.looseObject({
  current: NetWorthPointSchema,
  monthlyChange: z.number(),
  monthlyChangePercent: z.number(),
  snapshots: z.array(NetWorthPointSchema.extend({ date: DayStringSchema })),
  snapshotsTotal: CountSchema.optional(),
  snapshotsLimit: z.number().int().positive().optional(),
  snapshotsOffset: CountSchema.optional(),
});

/** `GET /api/info/exchange-rates` (routes/info/rates.ts). */
export const ExchangeRatesSchema = z.looseObject({
  total_rates: CountSchema,
  rates: z.array(
    z.looseObject({
      currency: z.string(),
      rate_to_eur: z.number(),
      rate_date: z.string(),
      fetched_at: z.string(),
    }),
  ),
  fallback_rates: z.record(z.string(), z.number()),
  source: z.enum(["database", "fallback"]),
  is_stale: z.boolean(),
  last_fetched_at: z.string().nullable(),
});

/** Acknowledgement bodies such as `POST /api/info/exchange-rates/refresh`. */
export const InfoMessageSchema = z.looseObject({ message: z.string() });
