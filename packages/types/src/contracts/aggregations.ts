import { z } from "zod";

import { IdSchema } from "./common.ts";

/*
 * Wire contracts for /api/aggregations/*. Each route answers
 * `{ data, meta: { computedAt, source } }` (calc modules' buildEnvelope)
 * inside the transport envelope; `source` is "mv", "live" or, for the
 * forecast caches, "cache".
 */

const CountSchema = z.number().int().nonnegative();
const DayStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const AggregationMetaSchema = z.looseObject({
  computedAt: z.string(),
  source: z.string(),
});

/** `{ data, meta }` around an aggregation payload. */
export const aggregationEnvelopeOf = <T extends z.ZodTypeAny>(data: T) =>
  z.looseObject({ data, meta: AggregationMetaSchema });

const MonthlySummaryMonthSchema = z.looseObject({
  month: z.number().int(),
  year: z.number().int(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  total_spending: z.number(),
  total_income: z.number(),
  net_amount: z.number(),
  transaction_count: CountSchema,
});

/**
 * `GET /api/aggregations/monthly-summary`. The summary's period bounds come
 * from the first/last month and are absent when there are no months.
 */
export const MonthlySummarySchema = aggregationEnvelopeOf(
  z.looseObject({
    months: z.array(MonthlySummaryMonthSchema),
    summary: z.looseObject({
      total_spending: z.number(),
      total_income: z.number(),
      net_amount: z.number(),
      transaction_count: CountSchema,
      period_start: z.string().nullable().optional(),
      period_end: z.string().nullable().optional(),
    }),
  }),
);

/** `GET /api/aggregations/recipient-insights` — infoRepositoryRecipients.getRecipientInsights. */
export const RecipientInsightsSchema = aggregationEnvelopeOf(
  z.looseObject({
    topMerchants: z.array(
      z.looseObject({
        recipientId: IdSchema,
        name: z.string(),
        totalSpend: z.number(),
        transactionCount: CountSchema,
        avgAmount: z.number(),
        firstSeen: z.string().nullable(),
        lastSeen: z.string().nullable(),
      }),
    ),
    monthOverMonth: z.array(
      z.looseObject({
        recipientId: IdSchema,
        name: z.string(),
        currentSpend: z.number(),
        previousSpend: z.number(),
        changePercent: z.number(),
      }),
    ),
  }),
);

/** `GET /api/aggregations/average-vs-current` — infoRepositoryAverageVsCurrent. */
export const AverageVsCurrentSchema = aggregationEnvelopeOf(
  z.looseObject({
    past_6_months: z.looseObject({
      avg_daily_spending: z.number(),
      avg_monthly_spending: z.number(),
      months_counted: CountSchema,
    }),
    current_month: z.looseObject({
      daily_data: z.array(
        z.looseObject({
          date: z.string(),
          spending: z.number(),
          income: z.number(),
        }),
      ),
      total_spending: z.number(),
      days_elapsed: z.number().int().positive(),
      days_in_month: z.number().int().positive(),
    }),
    comparison: z.looseObject({
      projected_monthly_total: z.number(),
      avg_monthly_spending: z.number(),
      variance: z.number(),
      pace: z.number().nullable(),
    }),
  }),
);

const BalancePointSchema = z.looseObject({
  date: DayStringSchema,
  balance: z.number(),
});

/**
 * `GET /api/aggregations/bank-balances` — infoRepositoryBanks. `drift`,
 * `anchor_date` and `post_anchor_count` are omitted (undefined) when the
 * account has no statement balance / balance anchor.
 */
export const BankBalancesSchema = aggregationEnvelopeOf(
  z.looseObject({
    accounts: z.array(
      z.looseObject({
        account_id: IdSchema,
        bank_account: z.string(),
        display_name: z.string(),
        balance: z.number(),
        drift: z.number().optional(),
        anchor_date: z.string().optional(),
        post_anchor_count: CountSchema.optional(),
        transaction_count: CountSchema,
        first_transaction: z.string().nullable(),
        last_transaction: z.string().nullable(),
      }),
    ),
    total_net_position: z.number(),
    history: z.record(z.string(), z.array(BalancePointSchema)),
    total_history: z.array(BalancePointSchema),
  }),
);

/** `GET /api/aggregations/category-pivot` — infoRepositoryStatistics.getCategoryPivot. */
export const CategoryPivotSchema = aggregationEnvelopeOf(
  z.looseObject({
    categoryPivot: z.record(
      z.string(),
      z.array(
        z.looseObject({
          categoryId: IdSchema.nullable(),
          categoryName: z.string(),
          categoryPathIds: z.array(IdSchema),
          categoryPathSegments: z.array(z.string()),
          total: z.number(),
          income: z.number(),
          expense: z.number(),
          transactionCount: CountSchema,
        }),
      ),
    ),
  }),
);

/** `GET /api/aggregations/recipient-by-year`. */
export const RecipientByYearSchema = aggregationEnvelopeOf(
  z.looseObject({
    recipientsByYear: z.record(
      z.string(),
      z.array(
        z.looseObject({
          recipientId: IdSchema,
          name: z.string(),
          totalSpend: z.number(),
          transactionCount: CountSchema,
        }),
      ),
    ),
  }),
);

/** infoRepositoryHelpers.buildPeriodPivot entity with the given id/label keys. */
const periodPivotOf = <S extends z.ZodRawShape>(identity: S) =>
  z.record(
    z.string(),
    z.array(
      z.looseObject({
        ...identity,
        total: z.number(),
        transactionCount: CountSchema,
      }),
    ),
  );

/** `GET /api/aggregations/recipient-pivot`. */
export const RecipientPivotSchema = aggregationEnvelopeOf(
  z.looseObject({
    recipientPivot: periodPivotOf({ recipientId: IdSchema, name: z.string() }),
    conversion: z.looseObject({
      usedHistoricalFallback: z.boolean(),
      affectedCurrencies: z.array(z.string()),
    }),
  }),
);

/** `GET /api/aggregations/tag-pivot`. */
export const TagPivotSchema = aggregationEnvelopeOf(
  z.looseObject({
    tagPivot: periodPivotOf({ tagId: IdSchema, slug: z.string() }),
  }),
);

/** `GET /api/aggregations/sankey`. */
export const SankeyFlowSchema = aggregationEnvelopeOf(
  z.looseObject({
    nodes: z.array(
      z.looseObject({ id: z.string(), label: z.string(), value: z.number() }),
    ),
    links: z.array(
      z.looseObject({
        source: z.string(),
        target: z.string(),
        value: z.number(),
      }),
    ),
    year: z.number().int(),
  }),
);

// ── Cash-flow forecast (services/calculations/forecast) ─────────────────────

const ForecastPointSchema = z.looseObject({
  date: z.string(),
  value: z.number(),
});
const ForecastBandsSchema = z.record(z.string(), z.array(ForecastPointSchema));
const DailyNetPointSchema = z.looseObject({
  date: z.string(),
  net: z.number(),
});

const ForecastMethodSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  daily: z.array(ForecastPointSchema),
  cumulative: z.array(ForecastPointSchema),
  bands: ForecastBandsSchema.nullable(),
  cumulative_bands: ForecastBandsSchema.nullable().optional(),
  error: z.string().nullable(),
});

const ForecastDiagnosticsSchema = z.looseObject({
  history_months: z.number().int(),
  backtest: z.array(
    z.looseObject({
      method_id: z.string(),
      label: z.string(),
      mae: z.number(),
      rmse: z.number(),
      mape: z.number().nullable(),
      months: CountSchema,
      per_month: z.array(
        z.looseObject({
          month: z.string(),
          mae: z.number(),
          rmse: z.number(),
          mape: z.number().nullable(),
          sample_days: CountSchema,
        }),
      ),
    }),
  ),
});

const forecastPayloadShape = {
  currency: z.string(),
  actual: z.array(
    z.looseObject({
      date: z.string(),
      net: z.number().nullable(),
      cumulative: z.number().nullable(),
    }),
  ),
  scheduled_actual: z.array(DailyNetPointSchema),
  methods: z.array(ForecastMethodSchema),
  planned: z.array(DailyNetPointSchema),
  diagnostics: ForecastDiagnosticsSchema.nullable(),
  history_months: z.number().int(),
  include_planned: z.boolean(),
};

/** `GET /api/aggregations/cashflow-forecast-methods` (live or the MC cache). */
export const CashflowForecastMethodsSchema = aggregationEnvelopeOf(
  z.looseObject({
    ...forecastPayloadShape,
    month: z.string(),
    days_in_month: z.number().int().positive(),
    current_day: z.number().int().positive(),
  }),
);

/** `GET /api/aggregations/cashflow-forecast-rolling`. */
export const CashflowForecastRollingSchema = aggregationEnvelopeOf(
  z.looseObject({
    ...forecastPayloadShape,
    window_start: z.string(),
    window_end: z.string(),
    today: z.string(),
    days_back: CountSchema,
    days_forward: CountSchema,
  }),
);

/**
 * `GET /api/aggregations/cashflow-forecast-accuracy`. Built in the route, not
 * by buildEnvelope: `meta` is `{ source: "db", userId }` without `computedAt`.
 * The stored metrics are nullable DOUBLE/INTEGER columns.
 */
export const CashflowForecastAccuracySchema = z.looseObject({
  data: z.looseObject({
    methods: z.array(
      z.looseObject({
        method_id: z.string(),
        as_of_month: z.string(),
        mae: z.number().nullable(),
        rmse: z.number().nullable(),
        mape: z.number().nullable(),
        sample_days: CountSchema.nullable(),
        history: z.array(
          z.looseObject({
            month: z.string(),
            mae: z.number().nullable(),
            rmse: z.number().nullable(),
            mape: z.number().nullable(),
            sample_days: CountSchema.nullable(),
          }),
        ),
      }),
    ),
    limit_months: z.number().int(),
  }),
  meta: z.looseObject({ source: z.string() }),
});
