/**
 * Market Lookup routes — powered by yahoo-finance2 library.
 */

import { Router } from 'express';
import { ApiErrorCode } from '@vision/types/errors';
import { AppError, ValidationError } from '../middleware/errorHandler.js';
import { createResearchCache } from '../services/research/researchCache.js';
import { getYahooClient } from '../services/prices/yahooClient.js';
import { toAppTz } from '../lib/timezone.js';

const router = Router();

// Per-symbol quote cache + in-flight coalescing. The Markets Overview polls this
// route for the whole active group (tens of symbols) every 60s, which otherwise
// became one uncached outbound Yahoo call per symbol per poll per open tab. A
// short TTL keeps the snapshot live while collapsing those into at most one call
// per symbol per window; the in-flight map coalesces concurrent identical fetches
// (e.g. overlapping symbol sets) so a cold symbol is fetched once, not N times.
const QUOTE_CACHE_TTL_MS = 60_000;
const quoteCache = createResearchCache();
/** @type {Map<string, Promise<any|null>>} */
const inFlightQuotes = new Map();

/**
 * Coerce a query-string param to a single trimmed string. Express parses a
 * repeated key (`?symbols=A&symbols=B`) as an array — calling `.split` on it
 * throws a TypeError that surfaced as an opaque 502. Joining arrays keeps the
 * repeated-key form working and guarantees a string for callers.
 *
 * @param {unknown} value
 * @returns {string}
 */
function coerceQueryString(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
  if (value == null) return '';
  return String(value);
}

function normalizeThumbnailUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice(7)}`;
  if (trimmed.startsWith('https://')) return trimmed;
  return null;
}

function pickBestThumbnail(thumbnail) {
  const resolutions = Array.isArray(thumbnail?.resolutions) ? thumbnail.resolutions : [];
  for (let i = resolutions.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeThumbnailUrl(resolutions[i]?.url);
    if (candidate) return candidate;
  }
  return null;
}

// yahoo-finance2 validates every upstream payload against its own schema and
// THROWS on any mismatch. Yahoo's responses drift (new quoteTypes, non-Yahoo
// entries missing fields, null meta) and vary by IP/geo, so an otherwise fine
// request intermittently 502s — search dropdowns go empty, charts break. We only
// read a small subset of well-known fields, so opt out of the throw: degrade to
// whatever data came back instead of failing the whole request.
const NO_VALIDATE = /** @type {{ validateResult: false }} */ ({ validateResult: false });

function upstreamError(message, cause) {
  return new AppError(message, { status: 502, code: ApiErrorCode.BAD_GATEWAY, cause });
}

/**
 * Convert a range string (e.g. '1mo', '5y') to a Date for period1.
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

// GET /api/market/search?q=apple
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 1) return res.ok({ items: [] });

  /** @type {any} */
  let results;
  try {
    const yahooFinance = await getYahooClient();
    results = await yahooFinance.search(q, { quotesCount: 8, newsCount: 0 }, NO_VALIDATE);
  } catch (err) {
    throw upstreamError('Market search unavailable', err);
  }

  const items = (results.quotes || [])
    .filter((r) => r.symbol)
    .map((r) => ({
      symbol: r.symbol,
      name: r.shortname || r.longname || r.symbol,
      type: r.quoteType || 'UNKNOWN',
      exchange: r.exchDisp || r.exchange || '',
    }));

  res.ok({ items });
});

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
async function getCachedQuote(sym, basic) {
  const key = `${basic ? 'basic' : 'full'}:${sym}`;
  const cached = quoteCache.get(key);
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

// GET /api/market/quote?symbols=AAPL,MSFT[&detail=basic]
// `detail=basic` returns price fields only; the default (full) additionally
// fetches quoteSummary for fundamentals/analyst data. Results are per-symbol
// cached (QUOTE_CACHE_TTL_MS) and concurrent identical fetches are coalesced.
router.get('/quote', async (req, res) => {
  const symbols = coerceQueryString(req.query.symbols);
  if (!symbols) throw new ValidationError('symbols parameter required');
  const basic = coerceQueryString(req.query.detail).trim() === 'basic';

  const symbolList = symbols.split(',').map((s) => s.trim()).filter(Boolean);
  const quoteResults = await Promise.allSettled(
    symbolList.map((sym) => getCachedQuote(sym, basic)),
  );

  const mapped = quoteResults
    .filter(/** @type {(r: PromiseSettledResult<any>) => r is PromiseFulfilledResult<any>} */
      (r) => r.status === 'fulfilled' && r.value !== null && r.value !== undefined)
    .map((r) => r.value);

  res.ok({ quotes: mapped });
});

// GET /api/market/chart?symbol=AAPL&range=1mo&interval=1d
router.get('/chart', async (req, res) => {
  const symbol = coerceQueryString(req.query.symbol);
  // `range`/`interval` are passed through to yahoo-finance2, which validates
  // them against its own literal-union types — leave them loosely typed.
  const { range = '1mo', interval = '1d' } = req.query;
  if (!symbol) throw new ValidationError('symbol parameter required');

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

  if (!result) return res.ok({ points: [] });

  const points = (result.quotes || [])
    .filter((p) => p.close != null)
    .map((p) => ({
      time: new Date(p.date).getTime(),
      close: p.close,
      high: p.high,
      low: p.low,
      volume: p.volume,
    }));

  res.ok({
    symbol: result.meta?.symbol,
    currency: result.meta?.currency,
    points,
  });
});

// GET /api/market/news?symbols=AAPL,MSFT&count=20
router.get('/news', async (req, res) => {
  const symbols = coerceQueryString(req.query.symbols);
  const count = coerceQueryString(req.query.count) || '20';
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
        return ((/** @type {any} */ (results)).news || []).map((n) => ({
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
  const unique = allNews
    .filter((n) => {
      if (seen.has(n.title)) return false;
      seen.add(n.title);
      return true;
    })
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, newsCount);

  res.ok({ articles: unique });
});

export default router;
