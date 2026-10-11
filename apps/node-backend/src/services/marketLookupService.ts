/**
 * Market Lookup service — powered by yahoo-finance2 via the shared lazy client
 * in services/prices/yahooClient.js.
 *
 * Owns everything non-HTTP behind routes/marketLookup.js (ADR-067 route →
 * service boundary): the per-symbol quote cache + in-flight coalescing, quote
 * assembly (mapQuoteCore / buildQuote / getCachedQuote), and the
 * search/chart/news fetch-and-shape logic. The route stays a thin handler that
 * parses/validates the request and delegates here; each exported function
 * returns the exact response `data` payload the route emits.
 */

import { ApiErrorCode } from '@vision/types/errors';
import { AppError } from '../middleware/errorHandler.ts';
import { createResearchCache } from './research/researchCache.ts';
import {
  getYahooClient,
  NO_VALIDATE,
  parseYahooPayload,
  requireYahooPayload,
  yahooDateMs,
  yahooChartResultSchema,
  yahooQuoteSchema,
  yahooQuoteSummarySchema,
  yahooSearchResultSchema,
} from './prices/yahooClient.ts';
import type {
  YahooChartInterval,
  YahooDateLike,
  YahooQuote,
  YahooQuoteSummary,
} from './prices/yahooClient.ts';
import { toAppTz } from '../lib/timezone.ts';
import { forEachConcurrent } from '../lib/concurrency.ts';

// Per-symbol quote cache + in-flight coalescing. The Markets Overview polls the
// quote route for the whole active group (tens of symbols) every 60s, which
// otherwise became one uncached outbound Yahoo call per symbol per poll per open
// tab. A short TTL keeps the snapshot live while collapsing those into at most
// one call per symbol per window; the in-flight map coalesces concurrent
// identical fetches (e.g. overlapping symbol sets) so a cold symbol is fetched
// once, not N times.
const QUOTE_CACHE_TTL_MS = 60_000;
const QUOTE_FETCH_CONCURRENCY = 6;
const quoteCache = createResearchCache();
const inFlightQuotes = new Map<string, Promise<MarketQuote | null>>();

export type MarketQuote = ReturnType<typeof mapQuoteCore> & {
  marketCap?: number | null;
  pe?: number | null;
  forwardPE?: number | null;
  dividendYield?: number | null;
  eps?: number | null;
  beta?: number | null;
  priceToBook?: number | null;
  analystConsensus?: {
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
  } | null;
  recentAnalystActions?: Array<{
    date: YahooDateLike | null | undefined;
    firm: string | null | undefined;
    toGrade: string | null | undefined;
    fromGrade: string | null;
    action: string | null | undefined;
    priceTarget: number | null;
  }>;
};

export interface MarketNewsItem {
  title: string | null | undefined;
  link: string | null | undefined;
  publisher: string | null | undefined;
  publishedAt: number | null;
  thumbnail: string | null;
  relatedSymbols: string[];
}

// NO_VALIDATE (see services/prices/yahooClient): yahoo-finance2 throws on any
// upstream schema drift, which intermittently 502'd otherwise fine requests.
// We read a small subset of well-known fields, so opt out of the throw and
// narrow whatever came back with the tolerant payload schemas instead.

function upstreamError(message: string, cause?: unknown): AppError {
  return new AppError(message, { status: 502, code: ApiErrorCode.BAD_GATEWAY, cause });
}

function normalizeThumbnailUrl(url: unknown): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice(7)}`;
  if (trimmed.startsWith('https://')) return trimmed;
  return null;
}

/**
 * @param thumbnail raw Yahoo `news[].thumbnail` — shape is upstream-controlled (NO_VALIDATE).
 */
function pickBestThumbnail(thumbnail: unknown): string | null {
  const raw =
    thumbnail && typeof thumbnail === 'object' && 'resolutions' in thumbnail
      ? thumbnail.resolutions
      : undefined;
  const resolutions: Array<{ url?: unknown } | null | undefined> = Array.isArray(raw) ? raw : [];
  for (let i = resolutions.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeThumbnailUrl(resolutions[i]?.url);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Convert a range string (e.g. '1mo', '5y') to a Date for period1.
 */
function rangeToDate(range: unknown): Date {
  const now = new Date();
  // Resolve calendar components in APP_TIMEZONE (ADR-009), not the server
  // process's local time, so this range boundary doesn't drift by a day
  // depending on host TZ.
  const { year, month, day } = toAppTz(now);
  switch (range) {
    case '1d': return new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    case '5d': return new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    case '1mo': return new Date(Date.UTC(year, month - 1 - 1, day));
    case '3mo': return new Date(Date.UTC(year, month - 1 - 3, day));
    case '6mo': return new Date(Date.UTC(year, month - 1 - 6, day));
    case '1y': return new Date(Date.UTC(year - 1, month - 1, day));
    case '2y': return new Date(Date.UTC(year - 2, month - 1, day));
    case '5y': return new Date(Date.UTC(year - 5, month - 1, day));
    case 'max': return new Date('1970-01-01');
    default: return new Date(Date.UTC(year, month - 1 - 1, day));
  }
}

/**
 * Core price fields available from a single `yahooFinance.quote()` call — no
 * `quoteSummary` needed. This is everything the benchmark strip, watchlist, and
 * dialogs render.
 */
function mapQuoteCore(q: YahooQuote) {
  return {
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: q.regularMarketPrice,
    change: q.regularMarketChange,
    changePercent: q.regularMarketChangePercent,
    currency: q.currency || 'USD',
    exchange: q.fullExchangeName || q.exchange,
    type: q.quoteType,
    open: q.regularMarketOpen,
    dayHigh: q.regularMarketDayHigh,
    dayLow: q.regularMarketDayLow,
    prevClose: q.regularMarketPreviousClose,
    volume: q.regularMarketVolume,
    avgVolume: q.averageDailyVolume3Month,
    high52w: q.fiftyTwoWeekHigh,
    low52w: q.fiftyTwoWeekLow,
  };
}

/**
 * Fetch and map a single symbol's quote from Yahoo. `basic` returns price fields
 * only (one quote() call); the default (full) additionally fetches quoteSummary
 * for fundamentals/analyst data — roughly 2× the outbound calls. Returns null
 * when the upstream quote is unavailable.
 */
async function buildQuote(sym: string, basic?: boolean): Promise<MarketQuote | null> {
  const yahooFinance = await getYahooClient();
  if (basic) {
    const q = parseYahooPayload(yahooQuoteSchema, await yahooFinance.quote(sym, {}, NO_VALIDATE));
    return q ? mapQuoteCore(q) : null;
  }

  const [quote, summary] = await Promise.allSettled([
    yahooFinance.quote(sym, {}, NO_VALIDATE),
    yahooFinance.quoteSummary(sym, {
      modules: [
        'summaryDetail',
        'defaultKeyStatistics',
        'price',
        'financialData',
        'recommendationTrend',
        'upgradeDowngradeHistory',
      ],
    }, NO_VALIDATE),
  ]);

  if (quote.status === 'rejected') return null;

  const q = parseYahooPayload(yahooQuoteSchema, quote.value);
  // No quote object for the symbol: unavailable, like a rejected quote.
  if (!q) return null;
  const s =
    summary.status === 'fulfilled'
      ? parseYahooPayload(yahooQuoteSummarySchema, summary.value)
      : undefined;

  const sd: NonNullable<YahooQuoteSummary['summaryDetail']> = s?.summaryDetail || {};
  const ks: NonNullable<YahooQuoteSummary['defaultKeyStatistics']> =
    s?.defaultKeyStatistics || {};
  const pr: NonNullable<YahooQuoteSummary['price']> = s?.price || {};

  const marketCap = sd.marketCap ?? pr.marketCap ?? q.marketCap;
  const trailingPE = sd.trailingPE ?? ks.trailingPE ?? q.trailingPE;
  const forwardPE = sd.forwardPE ?? ks.forwardPE ?? q.forwardPE;
  const dividendYield = sd.dividendYield ?? pr.dividendYield ?? q.dividendYield;
  const eps = pr.epsTrailingTwelveMonths ?? ks.trailingEps ?? q.epsTrailingTwelveMonths;
  const beta = sd.beta ?? ks.beta ?? q.beta;
  const priceToBook = ks.priceToBook ?? q.priceToBook;

  const trendBuckets = s?.recommendationTrend?.trend || [];
  const currentTrend = trendBuckets.find((t) => t.period === '0m') || trendBuckets[0] || null;
  const analystConsensus = currentTrend
    ? {
      strongBuy: currentTrend.strongBuy ?? 0,
      buy: currentTrend.buy ?? 0,
      hold: currentTrend.hold ?? 0,
      sell: currentTrend.sell ?? 0,
      strongSell: currentTrend.strongSell ?? 0,
    }
    : null;

  const recentAnalystActions = (s?.upgradeDowngradeHistory?.history || [])
    .slice(0, 10)
    .map((h) => ({
      date: h.epochGradeDate,
      firm: h.firm,
      toGrade: h.toGrade,
      fromGrade: h.fromGrade || null,
      action: h.action,
      priceTarget: h.currentPriceTarget ?? null,
    }));

  return {
    ...mapQuoteCore(q),
    marketCap,
    pe: trailingPE,
    forwardPE,
    dividendYield,
    eps,
    beta,
    priceToBook,
    analystConsensus,
    recentAnalystActions,
  };
}

/**
 * Cached, single-flight wrapper around {@link buildQuote}. A cache hit avoids the
 * outbound call; concurrent identical fetches share one in-flight promise. Only
 * successful (non-null) quotes are cached. Never throws — returns null so one bad
 * symbol can't fail a multi-symbol request.
 */
async function getCachedQuote(sym: string, basic?: boolean): Promise<MarketQuote | null> {
  const key = `${basic ? 'basic' : 'full'}:${sym}`;
  // Only buildQuote results are stored under these keys.
  const cached = quoteCache.get(key) as MarketQuote | null | undefined;
  if (cached !== undefined) return cached;

  const existing = inFlightQuotes.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await buildQuote(sym, basic);
      if (result !== null && result !== undefined) quoteCache.set(key, result, QUOTE_CACHE_TTL_MS);
      return result;
    } catch {
      return null;
    } finally {
      inFlightQuotes.delete(key);
    }
  })();
  inFlightQuotes.set(key, promise);
  return promise;
}

/** Test-only: clear the per-symbol quote cache and in-flight map between cases. */
export function __clearQuoteCacheForTests() {
  quoteCache.clear();
  inFlightQuotes.clear();
}

/**
 * Symbol search. Returns the `{ items }` payload for GET /api/market/search.
 *
 */
export async function searchSymbols(q: string) {
  let payload: unknown;
  try {
    const yahooFinance = await getYahooClient();
    payload = await yahooFinance.search(q, { quotesCount: 8, newsCount: 0 }, NO_VALIDATE);
  } catch (err) {
    throw upstreamError('Market search unavailable', err);
  }
  const results = requireYahooPayload(yahooSearchResultSchema, payload, 'search');

  const items = (results.quotes || [])
    .filter((r) => r.symbol)
    .map((r) => ({
      symbol: r.symbol,
      name: r.shortname || r.longname || r.symbol,
      type: r.quoteType || 'UNKNOWN',
      exchange: r.exchDisp || r.exchange || '',
    }));

  return { items };
}

/**
 * Batch quote lookup. Returns the canonical `{ items, total }` collection
 * payload for GET /api/market/quote. `basic` returns price fields only; the
 * default (full) additionally fetches quoteSummary for fundamentals/analyst
 * data. Results are per-symbol cached (QUOTE_CACHE_TTL_MS) and concurrent
 * identical fetches are coalesced; a failed symbol is dropped rather than
 * failing the batch.
 */
export async function getQuotes(symbolList: string[], basic: boolean) {
  const quoteResults = new Map<string, MarketQuote | null>();
  // A full lookup opens a quote + summary pair; reserve both slots so either
  // mode stays within six upstream calls per batch.
  const concurrency = basic ? QUOTE_FETCH_CONCURRENCY : QUOTE_FETCH_CONCURRENCY / 2;
  // Resolve each symbol once, including failed duplicates, then restore the
  // caller's order and duplicate entries in the response.
  await forEachConcurrent(
    [...new Set(symbolList)],
    concurrency,
    async (sym) => {
      try {
        quoteResults.set(sym, await getCachedQuote(sym, basic));
      } catch {
        quoteResults.set(sym, null);
      }
    },
  );

  const items = symbolList.map((sym) => quoteResults.get(sym))
    .filter((quote): quote is MarketQuote => quote !== null && quote !== undefined);

  return { items, total: items.length };
}

/**
 * Historical chart series. Returns the payload for GET /api/market/chart.
 * `range` maps to period1 (unknown ranges fall back to one month); `interval`
 * is the client's own interval vocabulary, which the route validates.
 *
 * The series travels in the canonical `items` key (with `total`); `symbol` and
 * `currency` ride alongside in the body.
 */
export async function getChart(
  symbol: string,
  { range = '1mo', interval = '1d' }: { range?: unknown; interval?: YahooChartInterval } = {},
) {
  let payload: unknown;
  try {
    // NO_VALIDATE: Yahoo intermittently returns an incomplete `meta` block (null
    // currency/regularMarketTime, missing regularMarketPrice); the time-series
    // `quotes` we render are still present, so degrade instead of 502-ing.
    const yahooFinance = await getYahooClient();
    payload = await yahooFinance.chart(symbol, {
      period1: rangeToDate(range),
      interval,
      includePrePost: false,
    }, NO_VALIDATE);
  } catch (err) {
    throw upstreamError('Market chart unavailable', err);
  }

  const result = parseYahooPayload(yahooChartResultSchema, payload);
  if (!result) return { items: [], total: 0 };

  const points = (result.quotes || [])
    .filter((p) => p.close != null)
    .map((p) => ({
      time: yahooDateMs(p.date),
      close: p.close,
      high: p.high,
      low: p.low,
      volume: p.volume,
    }));

  return {
    symbol: result.meta?.symbol,
    currency: result.meta?.currency,
    items: points,
    total: points.length,
  };
}

/**
 * Symbol news feed, deduplicated by title and sorted newest-first. Returns the
 * canonical `{ items, total }` collection payload for GET /api/market/news.
 *
 * @param symbols Comma-separated symbols ('' falls back to SPY,QQQ,DIA).
 * @param count Requested article count as a string; capped at 50.
 */
export async function getNews(symbols: string, count: string) {
  const querySymbols = symbols || 'SPY,QQQ,DIA';
  const newsCount = Math.min(parseInt(count, 10) || 20, 50);

  let newsResults;
  try {
    const yahooFinance = await getYahooClient();
    newsResults = await Promise.allSettled(
      querySymbols.split(',').slice(0, 10).map(async (sym): Promise<MarketNewsItem[]> => {
        const results = requireYahooPayload(
          yahooSearchResultSchema,
          await yahooFinance.search(sym.trim(), { quotesCount: 0, newsCount }, NO_VALIDATE),
          'search',
        );
        return (results.news || []).map((n) => ({
          title: n.title,
          link: n.link,
          publisher: n.publisher,
          publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime).getTime() : null,
          thumbnail: pickBestThumbnail(n.thumbnail),
          relatedSymbols: [sym.trim()],
        }));
      }),
    );
  } catch (err) {
    throw upstreamError('Market news unavailable', err);
  }

  const allNews = newsResults
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  const seen = new Set<string | null | undefined>();
  const articles = allNews
    .filter((n) => {
      if (seen.has(n.title)) return false;
      seen.add(n.title);
      return true;
    })
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, newsCount);

  return { items: articles, total: articles.length };
}
