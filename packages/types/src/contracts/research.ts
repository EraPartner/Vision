import { z } from "zod";

import { IdSchema } from "./common.ts";

/*
 * Wire contracts for the /api/research data, analytics, mapping and
 * provider-key reads (routes/research.ts). The AI research and dossier
 * routes live in researchAi.ts and researchDossiers.ts.
 *
 * The data endpoints relay whatever the winning provider adapter mapped
 * (services/research/adapters). The adapters read third-party JSON through
 * tolerant schemas, so a provider leaf can be absent or null; only the
 * container shape and the fields every adapter always sets are required.
 * When every provider is unavailable the route answers its stable empty
 * shape (`{items: []}`, `{points: []}`, `{articles: []}`) or `null`.
 */

const CountSchema = z.number().int().nonnegative();
/** A provider-sourced numeric leaf: absent, null, or a number. */
const ProviderNumber = z.number().nullable().optional();
const ProviderString = z.string().nullable().optional();

/**
 * One search hit. Finnhub and Twelve Data rows are not filtered on a
 * missing symbol, so every leaf is provider-sourced.
 */
const ResearchSearchItemSchema = z.looseObject({
  symbol: ProviderString,
  name: ProviderString,
  type: ProviderString,
  exchange: ProviderString,
});

/** `GET /api/research/search` — `{items}`. */
export const ResearchSearchSchema = z.looseObject({
  items: z.array(ResearchSearchItemSchema),
});

/** A chart / macro point. Finnhub leaves `close` unset for a missing candle. */
const ResearchChartPointSchema = z.looseObject({
  time: z.number(),
  close: ProviderNumber,
  high: ProviderNumber,
  low: ProviderNumber,
  volume: ProviderNumber,
});

/**
 * `GET /api/research/chart`. The unavailable fallback is `{points: []}`
 * without `symbol`/`currency`.
 */
export const ResearchChartSchema = z.looseObject({
  symbol: z.string().optional(),
  currency: ProviderString,
  points: z.array(ResearchChartPointSchema),
});

/** `GET /api/research/analyst` — `null` when no provider answered. */
export const ResearchAnalystSchema = z
  .looseObject({
    symbol: z.string(),
    consensus: z
      .looseObject({
        strongBuy: z.number(),
        buy: z.number(),
        hold: z.number(),
        sell: z.number(),
        strongSell: z.number(),
      })
      .nullable()
      .optional(),
    targetMean: ProviderNumber,
    targetHigh: ProviderNumber,
    targetLow: ProviderNumber,
    numberOfAnalysts: ProviderNumber,
    recentActions: z.array(
      z.looseObject({
        date: z.union([z.number(), z.string()]).nullable().optional(),
        firm: ProviderString,
        toGrade: ProviderString,
        fromGrade: ProviderString,
        action: ProviderString,
      }),
    ),
  })
  .nullable();

/** `GET /api/research/news` — `{articles}`. */
export const ResearchNewsSchema = z.looseObject({
  articles: z.array(
    z.looseObject({
      title: ProviderString,
      link: ProviderString,
      publisher: ProviderString,
      publishedAt: ProviderNumber,
      thumbnail: ProviderString,
      relatedSymbols: z.array(z.string()),
    }),
  ),
});

/** `GET /api/research/macro/search` — the union of the macro adapters' items. */
export const MacroSearchSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      provider: z.string(),
      seriesId: z.string(),
      title: z.string(),
      region: ProviderString,
      units: ProviderString,
      frequency: ProviderString,
      source: ProviderString,
    }),
  ),
});

/**
 * `GET /api/research/macro/series`. The unavailable fallback is
 * `{provider, seriesId, title: seriesId, points: []}`.
 */
export const MacroSeriesSchema = z.looseObject({
  provider: z.string(),
  seriesId: z.string(),
  title: z.string(),
  units: ProviderString,
  frequency: ProviderString,
  points: z.array(ResearchChartPointSchema),
});

const ScorecardSeveritySchema = z.enum(["ok", "caution", "warn", "risk"]);

/**
 * `GET /api/research/scorecard` — `null` when fundamentals are unavailable.
 * `fundamentals` is the merged provider snapshot (only present, non-null
 * fields survive the merge).
 */
export const ResearchScorecardSchema = z
  .looseObject({
    symbol: z.string(),
    fundamentals: z.looseObject({}),
    scorecard: z.looseObject({
      score: z.number().nullable(),
      grade: z.string(),
      evaluated: CountSchema,
      counts: z.record(ScorecardSeveritySchema, CountSchema),
      flags: z.array(
        z.looseObject({
          metric: z.string(),
          category: z.string(),
          better: z.string(),
          value: z.number(),
          severity: ScorecardSeveritySchema,
          code: z.string(),
          reasonKey: z.string(),
          reason: z.string(),
          benchmark: z.string(),
        }),
      ),
    }),
  })
  .nullable();

const ForecastBandSchema = {
  p10: z.number(),
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  p90: z.number(),
};

/**
 * `POST /api/research/portfolio-forecast` (portfolioProjection
 * .runPortfolioForecast): `{available: false, reason[, historyDays]}` or the
 * full projection. `targetValue`/`probTarget` are unset without a target and
 * `goalMonth` is only present when one was honoured.
 */
export const PortfolioForecastSchema = z.discriminatedUnion("available", [
  z.looseObject({
    available: z.literal(false),
    reason: z.enum(["no_holdings", "insufficient_history"]),
    historyDays: CountSchema.optional(),
  }),
  z.looseObject({
    available: z.literal(true),
    currency: z.string(),
    method: z.enum(["parametric", "block_bootstrap"]),
    horizonMonths: z.number().int().positive(),
    paths: z.number().int().positive(),
    seed: z.string(),
    historyDays: CountSchema,
    flowArtifactDays: CountSchema,
    lowConfidence: z.boolean(),
    startValue: z.number(),
    startInvested: z.number(),
    monthlyContribution: z.number(),
    totalContributions: z.number(),
    netInvested: z.number(),
    expectedAnnualReturn: z.number(),
    historicalAnnualReturn: z.number(),
    annualVolatility: z.number(),
    forwardBlend: z.number(),
    usedForward: z.boolean(),
    forwardHoldings: z.array(
      z.looseObject({
        symbol: z.string(),
        expectedAnnual: z.number(),
        growth: z.number(),
        dividendYield: z.number().optional(),
      }),
    ),
    projected: z.looseObject({ mean: z.number(), ...ForecastBandSchema }),
    probBelowInvested: z.number(),
    targetValue: z.number().optional(),
    goalMonth: z.number().int().positive().optional(),
    probTarget: z.number().optional(),
    points: z.array(
      z.looseObject({
        monthIndex: z.number().int().positive(),
        date: z.string(),
        netInvested: z.number(),
        ...ForecastBandSchema,
      }),
    ),
  }),
]);

/** One `instrument_provider_map` row (database/rows/portfolio.ts). */
export const InstrumentProviderMappingSchema = z.looseObject({
  id: IdSchema,
  instrument_key: z.string(),
  key_type: z.enum(["isin", "internal"]),
  provider: z.string(),
  provider_symbol: z.string().nullable(),
  resolved_name: z.string().nullable(),
  exchange: z.string().nullable(),
  currency: z.string().nullable(),
  status: z.enum(["confirmed", "auto", "failed"]),
  verified_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** `GET` and `POST /api/research/mappings` — `{items, total}`. */
export const InstrumentProviderMappingListSchema = z.looseObject({
  items: z.array(InstrumentProviderMappingSchema),
  total: CountSchema,
});

/**
 * `POST /api/research/mappings/resolve`. A proposal copied from a stored row
 * carries its nullable columns; one from a live search carries the
 * adapter's (provider-sourced) top hit and candidates.
 */
export const MappingResolveSchema = z.looseObject({
  instrument_key: z.string(),
  key_type: z.enum(["isin", "internal"]),
  proposals: z.array(
    z.looseObject({
      provider: z.string(),
      status: z.string(),
      providerSymbol: ProviderString,
      resolvedName: ProviderString,
      exchange: ProviderString,
      currency: ProviderString,
      candidates: z.array(ResearchSearchItemSchema).optional(),
      reason: z.string().optional(),
      error: z.string().optional(),
      fromHolding: z.boolean().optional(),
      fromStore: z.boolean().optional(),
    }),
  ),
  existing: z.array(InstrumentProviderMappingSchema),
});

/** `POST /api/research/mappings/audit` (researchMappingService.audit). */
export const MappingAuditSchema = z.looseObject({
  ok: z.boolean(),
  quotes: z.array(
    z.looseObject({
      provider: z.string(),
      currency: ProviderString,
      price: ProviderNumber,
      skipped: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  discrepancies: z.array(
    z.looseObject({
      type: z.enum(["currency_mismatch", "price_outlier"]),
      provider: z.string().optional(),
    }),
  ),
});

/**
 * `GET` and `PUT /api/research/provider-keys` — `{items, total}`. `masked`
 * is unset when the provider has no key.
 */
export const ResearchProviderKeyListSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      provider: z.string(),
      label: z.string(),
      envVar: z.string(),
      configured: z.boolean(),
      source: z.enum(["settings", "env", "none"]),
      masked: z.string().optional(),
    }),
  ),
  total: CountSchema,
});
