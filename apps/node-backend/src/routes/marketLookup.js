/**
 * Market Lookup routes — powered by yahoo-finance2 library.
 */

import { Router } from 'express';
import YahooFinance from 'yahoo-finance2';
import { ApiErrorCode } from '@vision/types/errors';
import { AppError, ValidationError } from '../middleware/errorHandler.js';

const router = Router();

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
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// yahoo-finance2 validates every upstream payload against its own schema and
// THROWS on any mismatch. Yahoo's responses drift (new quoteTypes, non-Yahoo
// entries missing fields, null meta) and vary by IP/geo, so an otherwise fine
// request intermittently 502s — search dropdowns go empty, charts break. We only
// read a small subset of well-known fields, so opt out of the throw: degrade to
// whatever data came back instead of failing the whole request.
const NO_VALIDATE = { validateResult: false };

function upstreamError(message, cause) {
  return new AppError(message, { status: 502, code: ApiErrorCode.BAD_GATEWAY, cause });
}

/**
 * Convert a range string (e.g. '1mo', '5y') to a Date for period1.
 */
function rangeToDate(range) {
  const now = new Date();
  switch (range) {
    case '1d': return new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    case '5d': return new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    case '1mo': return new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    case '3mo': return new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    case '6mo': return new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    case '1y': return new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    case '2y': return new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
    case '5y': return new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
    case 'max': return new Date('1970-01-01');
    default: return new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
  }
}

// GET /api/market/search?q=apple
router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 1) return res.ok({ items: [] });

  let results;
  try {
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

// GET /api/market/quote?symbols=AAPL,MSFT
router.get('/quote', async (req, res) => {
  const symbols = coerceQueryString(req.query.symbols);
  if (!symbols) throw new ValidationError('symbols parameter required');

  let quoteResults;
  try {
    const symbolList = symbols.split(',').map((s) => s.trim()).filter(Boolean);
    quoteResults = await Promise.allSettled(
      symbolList.map(async (sym) => {
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
      }),
    );
  } catch (err) {
    throw upstreamError('Market quote unavailable', err);
  }

  const mapped = quoteResults
    .filter(/** @type {(r: PromiseSettledResult<any>) => r is PromiseFulfilledResult<any>} */
      (r) => r.status === 'fulfilled' && r.value !== null)
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

  let result;
  try {
    // NO_VALIDATE: Yahoo intermittently returns an incomplete `meta` block (null
    // currency/regularMarketTime, missing regularMarketPrice); the time-series
    // `quotes` we render are still present, so degrade instead of 502-ing.
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
    newsResults = await Promise.allSettled(
      querySymbols.split(',').slice(0, 10).map(async (sym) => {
        const results = await yahooFinance.search(sym.trim(), {
          quotesCount: 0,
          newsCount,
        }, NO_VALIDATE);
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
