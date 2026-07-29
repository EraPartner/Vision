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
import { AppError } from '../middleware/errorHandler.js';
import { createResearchCache } from './research/researchCache.js';
import { getYahooClient } from './prices/yahooClient.js';
import { toAppTz } from '../lib/timezone.js';

// Per-symbol quote cache + in-flight coalescing. The Markets Overview polls the
// quote route for the whole active group (tens of symbols) every 60s, which
// otherwise became one uncached outbound Yahoo call per symbol per poll per open
// tab. A short TTL keeps the snapshot live while collapsing those into at most
// one call per symbol per window; the in-flight map coalesces concurrent
// identical fetches (e.g. overlapping symbol sets) so a cold symbol is fetched
// once, not N times.
const QUOTE_CACHE_TTL_MS = 60_000;
const quoteCache = createResearchCache();
/** @type {Map<string, Promise<any|null>>} */
const inFlightQuotes = new Map();

// yahoo-finance2 validates every upstream payload against its own schema and
// THROWS on any mismatch. Yahoo's responses drift (new quoteTypes, non-Yahoo
// entries missing fields, null meta) and vary by IP/geo, so an otherwise fine
// request intermittently 502s — search dropdowns go empty, charts break. We only
// read a small subset of well-known fields, so opt out of the throw: degrade to
// whatever data came back instead of failing the whole request.
const NO_VALIDATE = /** @type {{ validateResult: false }} */ ({ validateResult: false });

/**
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {AppError}
 */
function upstreamError(message, cause) {
  return new AppError(message, { status: 502, code: ApiErrorCode.BAD_GATEWAY, cause });
}

/**
 * @param {unknown} url
 * @returns {string|null}
 */
function normalizeThumbnailUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice(7)}`;
  if (trimmed.startsWith('https://')) return trimmed;
  return null;
}

/**
 * @param {any} thumbnail raw Yahoo `news[].thumbnail` — shape is upstream-controlled (NO_VALIDATE).
 * @returns {string|null}
 */
function pickBestThumbnail(thumbnail) {
  const resolutions = Array.isArray(thumbnail?.resolutions) ? thumbnail.resolutions : [];
  for (let i = resolutions.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeThumbnailUrl(resolutions[i]?.url);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Convert a range string (e.g. '1mo', '5y') to a Date for period1.
 * @param {string} range
 * @returns {Date}
 */
function rangeToDate(range) {
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
 * @param {any} q
 */
function mapQuoteCore(q) {
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
 * @param {string} sym
 * @param {boolean} [basic]
 * @returns {Promise<object|null>}
 */
async function buildQuote(sym, basic) {
  const yahooFinance = await getYahooClient();
  if (basic) {
    const q = /** @type {any} */ (await yahooFinance.quote(sym, {}, NO_VALIDATE));
    return mapQuoteCore(q);
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

  const q = /** @type {any} */ (quote.value);
  const s = /** @type {any} */ (summary.status === 'fulfilled' ? summary.value : null);

  /** @type {any} */
  const sd = s?.summaryDetail || {};
  /** @type {any} */
  const ks = s?.defaultKeyStatistics || {};
  /** @type {any} */
  const pr = s?.price || {};

  const marketCap = sd.marketCap ?? pr.marketCap ?? q.marketCap;
  const trailingPE = sd.trailingPE ?? ks.trailingPE ?? q.trailingPE;
  const forwardPE = sd.forwardPE ?? ks.forwardPE ?? q.forwardPE;
  const dividendYield = sd.dividendYield ?? pr.dividendYield ?? q.dividendYield;
  const eps = pr.epsTrailingTwelveMonths ?? ks.trailingEps ?? q.epsTrailingTwelveMonths;
  const beta = sd.beta ?? ks.beta ?? q.beta;
  const priceToBook = ks.priceToBook ?? q.priceToBook;

  const trendBuckets = s?.recommendationTrend?.trend || [];
  const currentTrend = trendBuckets.find((/** @type {any} */ t) => t.period === '0m') || trendBuckets[0] || null;
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
    .map((/** @type {any} */ h) => ({
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
 * @param {string} sym
 * @param {boolean} [basic]
 * @returns {Promise<object|null>}
 */
async function getCachedQuote(sym, basic) {
  const key = `${basic ? 'basic' : 'full'}:${sym}`;
  const cached = /** @type {object|null|undefined} */ (quoteCache.get(key));
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
 * @param {string} q
 * @returns {Promise<{ items: Array<object> }>}
 */
export async function searchSymbols(q) {
  /** @type {any} */
  let results;
  try {
    const yahooFinance = await getYahooClient();
    results = await yahooFinance.search(q, { quotesCount: 8, newsCount: 0 }, NO_VALIDATE);
  } catch (err) {
    throw upstreamError('Market search unavailable', err);
  }

  const items = (results.quotes || [])
    .filter((/** @type {any} */ r) => r.symbol)
    .map((/** @type {any} */ r) => ({
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
 *
 * @param {string[]} symbolList
 * @param {boolean} basic
 * @returns {Promise<{ items: Array<object>, total: number }>}
 */
export async function getQuotes(symbolList, basic) {
  const quoteResults = await Promise.allSettled(
    symbolList.map((sym) => getCachedQuote(sym, basic)),
  );

  const items = quoteResults
    .filter(/** @type {(r: PromiseSettledResult<any>) => r is PromiseFulfilledResult<any>} */
      (r) => r.status === 'fulfilled' && r.value !== null && r.value !== undefined)
    .map((r) => r.value);

  return { items, total: items.length };
}

/**
 * Historical chart series. Returns the payload for GET /api/market/chart.
 * `range`/`interval` are passed through to yahoo-finance2, which validates them
 * against its own literal-union types — leave them loosely typed.
 *
 * The series travels in the canonical `items` key (with `total`); `symbol` and
 * `currency` ride alongside in the body.
 *
 * @param {string} symbol
 * @param {{ range?: any, interval?: any }} [options]
 * @returns {Promise<{ symbol?: string, currency?: string, items: Array<object>, total: number }>}
 */
export async function getChart(symbol, { range = '1mo', interval = '1d' } = {}) {
  /** @type {any} */
  let result;
  try {
    // NO_VALIDATE: Yahoo intermittently returns an incomplete `meta` block (null
    // currency/regularMarketTime, missing regularMarketPrice); the time-series
    // `quotes` we render are still present, so degrade instead of 502-ing.
    const yahooFinance = await getYahooClient();
    result = await yahooFinance.chart(symbol, {
      period1: rangeToDate(range),
      interval,
      includePrePost: false,
    }, NO_VALIDATE);
  } catch (err) {
    throw upstreamError('Market chart unavailable', err);
  }

  if (!result) return { items: [], total: 0 };

  const points = (result.quotes || [])
    .filter((/** @type {any} */ p) => p.close != null)
    .map((/** @type {any} */ p) => ({
      time: new Date(p.date).getTime(),
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
 * @param {string} symbols Comma-separated symbols ('' falls back to SPY,QQQ,DIA).
 * @param {string} count Requested article count as a string; capped at 50.
 * @returns {Promise<{ items: Array<object>, total: number }>}
 */
export async function getNews(symbols, count) {
  const querySymbols = symbols || 'SPY,QQQ,DIA';
  const newsCount = Math.min(parseInt(count, 10) || 20, 50);

  let newsResults;
  try {
    const yahooFinance = await getYahooClient();
    newsResults = await Promise.allSettled(
      querySymbols.split(',').slice(0, 10).map(async (sym) => {
        const results = await yahooFinance.search(sym.trim(), {
          quotesCount: 0,
          newsCount,
        }, NO_VALIDATE);
        return ((/** @type {any} */ (results)).news || []).map((/** @type {any} */ n) => ({
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

  const seen = new Set();
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
