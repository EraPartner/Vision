/**
 * Lazy, module-cached yahoo-finance2 client.
 *
 * yahoo-finance2 pulls a large dependency graph and costs ~100ms to import.
 * Three modules (routes/marketLookup, this directory's priceProviderRegistry,
 * and research/adapters/yahooAdapter) used to import it statically, so it loaded
 * as part of the pre-`listen()` import graph on every boot — before /health
 * could go green — even though most requests never touch Yahoo. This defers both
 * the dynamic import and the client construction to first actual use, mirroring
 * the puppeteer lazy pattern in services/reports/puppeteerRenderer.ts.
 *
 * The client is created once and shared: `getYahooClient()` returns the same
 * cached promise on every call.
 *
 * Callers that opt out of the library's result validation (`validateResult:
 * false`, see {@link NO_VALIDATE}) get an untyped payload back; the tolerant
 * schemas below are the boundary that narrows it.
 */

import { z } from 'zod';
import { looseArray, looseString } from '../research/adapters/schemas.ts';

/** The yahoo-finance2 client instance (type-only import; the module still loads lazily). */
export type YahooClient = InstanceType<typeof import('yahoo-finance2').default>;

let clientPromise: Promise<YahooClient> | null = null;

/**
 * Resolve the shared yahoo-finance2 client, importing and constructing it on
 * first call and returning the cached instance thereafter.
 */
export function getYahooClient(): Promise<YahooClient> {
  if (!clientPromise) {
    clientPromise = import('yahoo-finance2').then(
      ({ default: YahooFinance }) => new YahooFinance({ suppressNotices: ['yahooSurvey'] }),
    );
  }
  return clientPromise;
}

/** The interval vocabulary of the client's `chart()` endpoint. */
export type YahooChartInterval = NonNullable<Parameters<YahooClient['chart']>[1]['interval']>;

/**
 * Opt out of yahoo-finance2's result validation, which THROWS on any schema
 * drift. Yahoo's responses drift (new quoteTypes, entries missing fields, null
 * meta) and vary by IP/geo; callers read a small subset of well-known fields,
 * so they degrade to whatever came back instead. The library then types the
 * result as untyped, and callers narrow it with the schemas below.
 */
export const NO_VALIDATE: { validateResult: false } = { validateResult: false };

// ─── Tolerant payload schemas (NO_VALIDATE results) ──────────────────────────
// Yahoo controls these shapes, so every field is optional and a field of the
// wrong type degrades like a missing one (null passes through unchanged).
// Unknown fields are kept. Callers fall back to their missing-payload
// behaviour when the envelope itself is not an object.

const optNumber = z.number().nullish().catch(undefined);
/** Dates arrive coerced to `Date`, or raw as epoch numbers / strings. */
const optDateLike = z.union([z.date(), z.number(), z.string()]).nullish().catch(undefined);

/** An optional nested object whose own fields are tolerant. */
function section<S extends z.core.$ZodLooseShape>(shape: S) {
  return z.looseObject(shape).nullish().catch(undefined);
}

/** One `quote()` result. */
export const yahooQuoteSchema = z.looseObject({
  symbol: looseString,
  shortName: looseString,
  longName: looseString,
  regularMarketPrice: optNumber,
  regularMarketChange: optNumber,
  regularMarketChangePercent: optNumber,
  currency: looseString,
  fullExchangeName: looseString,
  exchange: looseString,
  quoteType: looseString,
  regularMarketOpen: optNumber,
  regularMarketDayHigh: optNumber,
  regularMarketDayLow: optNumber,
  regularMarketPreviousClose: optNumber,
  regularMarketVolume: optNumber,
  averageDailyVolume3Month: optNumber,
  fiftyTwoWeekHigh: optNumber,
  fiftyTwoWeekLow: optNumber,
  marketCap: optNumber,
  trailingPE: optNumber,
  forwardPE: optNumber,
  dividendYield: optNumber,
  epsTrailingTwelveMonths: optNumber,
  beta: optNumber,
  priceToBook: optNumber,
});
export type YahooQuote = z.output<typeof yahooQuoteSchema>;

/** A `search()` result: symbol matches and news. */
export const yahooSearchResultSchema = z.looseObject({
  quotes: looseArray(
    z.looseObject({
      symbol: looseString,
      shortname: looseString,
      longname: looseString,
      quoteType: looseString,
      exchDisp: looseString,
      exchange: looseString,
    }),
  ),
  news: looseArray(
    z.looseObject({
      title: looseString,
      link: looseString,
      publisher: looseString,
      providerPublishTime: optDateLike,
      /** Raw; the thumbnail pickers narrow it themselves. */
      thumbnail: z.unknown().optional(),
    }),
  ),
});
export type YahooSearchResult = z.output<typeof yahooSearchResultSchema>;

/** A `chart()` result: series metadata plus one entry per bar. */
export const yahooChartResultSchema = z.looseObject({
  meta: section({ symbol: looseString, currency: looseString }),
  quotes: looseArray(
    z.looseObject({
      date: optDateLike,
      close: optNumber,
      high: optNumber,
      low: optNumber,
      volume: optNumber,
    }),
  ),
});
export type YahooChartResult = z.output<typeof yahooChartResultSchema>;

/** A `quoteSummary()` result, limited to the modules and fields Vision reads. */
export const yahooQuoteSummarySchema = z.looseObject({
  summaryDetail: section({
    marketCap: optNumber,
    trailingPE: optNumber,
    forwardPE: optNumber,
    dividendYield: optNumber,
    payoutRatio: optNumber,
    beta: optNumber,
  }),
  defaultKeyStatistics: section({
    trailingPE: optNumber,
    forwardPE: optNumber,
    pegRatio: optNumber,
    trailingEps: optNumber,
    beta: optNumber,
    priceToBook: optNumber,
  }),
  price: section({
    marketCap: optNumber,
    longName: looseString,
    shortName: looseString,
    currency: looseString,
    dividendYield: optNumber,
    epsTrailingTwelveMonths: optNumber,
  }),
  financialData: section({
    freeCashflow: optNumber,
    profitMargins: optNumber,
    grossMargins: optNumber,
    operatingMargins: optNumber,
    totalRevenue: optNumber,
    revenueGrowth: optNumber,
    earningsGrowth: optNumber,
    returnOnEquity: optNumber,
    debtToEquity: optNumber,
    currentRatio: optNumber,
    quickRatio: optNumber,
    targetMeanPrice: optNumber,
    targetHighPrice: optNumber,
    targetLowPrice: optNumber,
    numberOfAnalystOpinions: optNumber,
  }),
  assetProfile: section({ sector: looseString }),
  recommendationTrend: section({
    trend: looseArray(
      z.looseObject({
        period: looseString,
        strongBuy: optNumber,
        buy: optNumber,
        hold: optNumber,
        sell: optNumber,
        strongSell: optNumber,
      }),
    ),
  }),
  upgradeDowngradeHistory: section({
    history: looseArray(
      z.looseObject({
        epochGradeDate: optDateLike,
        firm: looseString,
        toGrade: looseString,
        fromGrade: looseString,
        action: looseString,
        currentPriceTarget: optNumber,
      }),
    ),
  }),
});
export type YahooQuoteSummary = z.output<typeof yahooQuoteSummarySchema>;

/**
 * Narrow an untyped (NO_VALIDATE) payload with one of the schemas above, or
 * `undefined` when it is not an object at all (e.g. no result for the symbol).
 */
export function parseYahooPayload<S extends z.ZodType>(
  schema: S,
  payload: unknown,
): z.output<S> | undefined {
  const result = schema.safeParse(payload);
  return result.success ? result.data : undefined;
}

/**
 * {@link parseYahooPayload} for callers that cannot degrade without a payload:
 * throws when the payload is not an object (the untyped code failed on the
 * first property read instead).
 */
export function requireYahooPayload<S extends z.ZodType>(
  schema: S,
  payload: unknown,
  endpoint: string,
): z.output<S> {
  const parsed = parseYahooPayload(schema, payload);
  if (parsed === undefined) throw new Error(`Yahoo ${endpoint} returned no result`);
  return parsed;
}

/** A tolerant date field: a coerced `Date`, or a raw epoch number / string. */
export type YahooDateLike = Date | number | string;

/**
 * `new Date(value).getTime()` for a tolerant date field, keeping the Date
 * constructor's own coercion of absent values (null → 0, undefined → NaN).
 */
export function yahooDateMs(value: YahooDateLike | null | undefined): number {
  if (value === undefined) return Number.NaN;
  return new Date(value ?? 0).getTime();
}

/** Test-only: drop the cached client so a fresh mock can be wired between cases. */
export function __resetYahooClientForTests(): void {
  clientPromise = null;
}
