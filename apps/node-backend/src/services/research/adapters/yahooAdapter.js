/**
 * Yahoo research adapter (ADR-079).
 *
 * Wraps yahoo-finance2 behind the research adapter shape: one method per data
 * type (search / quote / chart / fundamentals / analyst / news). Needs no API
 * key, so it is always usable and serves as the baseline provider the others
 * light up alongside as keys are provisioned.
 *
 * Each method returns normalized data or throws — the aggregator records the
 * error and falls through to the next provider in the capability chain.
 *
 * NO_VALIDATE: yahoo-finance2 validates every upstream payload and throws on any
 * schema drift; Yahoo's responses drift and vary by IP/geo. We read a small
 * subset of known fields, so we opt out of the throw and degrade to whatever
 * came back — matching services/marketLookupService.js.
 */

import { getYahooClient } from '../../prices/yahooClient.js';

const NO_VALIDATE = /** @type {{ validateResult: false }} */ ({ validateResult: false });

const RANGE_TO_PERIOD1 = {
  '1d': () => new Date(Date.now() - 1 * 86_400_000),
  '5d': () => new Date(Date.now() - 5 * 86_400_000),
  '1mo': () => monthsAgo(1),
  '3mo': () => monthsAgo(3),
  '6mo': () => monthsAgo(6),
  '1y': () => yearsAgo(1),
  '2y': () => yearsAgo(2),
  '5y': () => yearsAgo(5),
  max: () => new Date('1970-01-01'),
};

/** @param {number} n */
function monthsAgo(n) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() - n, d.getDate());
}

/** @param {number} n */
function yearsAgo(n) {
  const d = new Date();
  return new Date(d.getFullYear() - n, d.getMonth(), d.getDate());
}

/** @param {string} range */
function rangeToDate(range) {
  return (RANGE_TO_PERIOD1[/** @type {keyof typeof RANGE_TO_PERIOD1} */ (range)] ?? RANGE_TO_PERIOD1['1mo'])();
}

/** @param {unknown} url */
function normalizeThumbnailUrl(url) {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice(7)}`;
  if (trimmed.startsWith('https://')) return trimmed;
  return undefined;
}

/**
 * @param {any} thumbnail raw yahoo-finance2 payload (NO_VALIDATE — see file header).
 */
function pickBestThumbnail(thumbnail) {
  const resolutions = Array.isArray(thumbnail?.resolutions) ? thumbnail.resolutions : [];
  for (let i = resolutions.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeThumbnailUrl(resolutions[i]?.url);
    if (candidate) return candidate;
  }
  return undefined;
}

const yahooAdapter = {
  key: 'yahoo',

  /** @param {string} query */
  async search(query) {
    const yahoo = await getYahooClient();
    const results = /** @type {any} */ (
      await yahoo.search(query, { quotesCount: 8, newsCount: 0 }, NO_VALIDATE)
    );
    const items = (results.quotes || [])
      .filter((/** @type {any} */ r) => r.symbol)
      .map((/** @type {any} */ r) => ({
        symbol: r.symbol,
        name: r.shortname || r.longname || r.symbol,
        type: r.quoteType || 'UNKNOWN',
        exchange: r.exchDisp || r.exchange || '',
      }));
    return { items };
  },

  /** @param {string} symbol */
  async quote(symbol) {
    const yahoo = await getYahooClient();
    const q = /** @type {any} */ (await yahoo.quote(symbol, {}, NO_VALIDATE));
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
  },

  /**
   * @param {string} symbol
   * @param {{ range?: string, interval?: string }} [opts]
   */
  async chart(symbol, { range = '1mo', interval = '1d' } = {}) {
    const yahoo = await getYahooClient();
    const result = /** @type {any} */ (
      await yahoo.chart(symbol, { period1: rangeToDate(range), interval: /** @type {any} */ (interval), includePrePost: false }, NO_VALIDATE)
    );
    const points = (result?.quotes || [])
      .filter((/** @type {any} */ p) => p.close != null)
      .map((/** @type {any} */ p) => ({
        time: new Date(p.date).getTime(),
        close: p.close,
        high: p.high,
        low: p.low,
        volume: p.volume,
      }));
    return { symbol: result?.meta?.symbol ?? symbol, currency: result?.meta?.currency, points };
  },

  /** @param {string} symbol */
  async fundamentals(symbol) {
    const yahoo = await getYahooClient();
    const s = /** @type {any} */ (
      await yahoo.quoteSummary(
        symbol,
        {
          modules: [
            'summaryDetail', 'defaultKeyStatistics', 'price', 'financialData', 'assetProfile',
          ],
        },
        NO_VALIDATE,
      )
    );
    const sd = s?.summaryDetail || {};
    const ks = s?.defaultKeyStatistics || {};
    const pr = s?.price || {};
    const fd = s?.financialData || {};
    const ap = s?.assetProfile || {};
    const marketCap = sd.marketCap ?? pr.marketCap;
    const freeCashFlow = fd.freeCashflow;
    const fcfYield = Number.isFinite(freeCashFlow) && Number.isFinite(marketCap) && marketCap > 0
      ? freeCashFlow / marketCap
      : undefined;
    return {
      symbol,
      name: pr.longName || pr.shortName || symbol,
      currency: pr.currency,
      sector: ap.sector,
      marketCap,
      pe: sd.trailingPE ?? ks.trailingPE,
      forwardPE: sd.forwardPE ?? ks.forwardPE,
      pegRatio: ks.pegRatio,
      dividendYield: sd.dividendYield ?? pr.dividendYield,
      payoutRatio: sd.payoutRatio,
      eps: pr.epsTrailingTwelveMonths ?? ks.trailingEps,
      beta: sd.beta ?? ks.beta,
      priceToBook: ks.priceToBook,
      profitMargin: fd.profitMargins,
      grossMargin: fd.grossMargins,
      operatingMargin: fd.operatingMargins,
      revenue: fd.totalRevenue,
      revenueGrowth: fd.revenueGrowth,
      earningsGrowth: fd.earningsGrowth,
      returnOnEquity: fd.returnOnEquity,
      // Yahoo reports debt/equity as a percentage (150 = 1.5×); normalize to a ratio.
      debtToEquity: Number.isFinite(fd.debtToEquity) ? fd.debtToEquity / 100 : undefined,
      currentRatio: fd.currentRatio,
      quickRatio: fd.quickRatio,
      freeCashFlow,
      fcfYield,
    };
  },

  /** @param {string} symbol */
  async analyst(symbol) {
    const yahoo = await getYahooClient();
    const s = /** @type {any} */ (
      await yahoo.quoteSummary(
        symbol,
        { modules: ['recommendationTrend', 'upgradeDowngradeHistory', 'financialData'] },
        NO_VALIDATE,
      )
    );
    const trendBuckets = s?.recommendationTrend?.trend || [];
    const current = trendBuckets.find((/** @type {any} */ t) => t.period === '0m') || trendBuckets[0];
    const consensus = current
      ? {
          strongBuy: current.strongBuy ?? 0,
          buy: current.buy ?? 0,
          hold: current.hold ?? 0,
          sell: current.sell ?? 0,
          strongSell: current.strongSell ?? 0,
        }
      : undefined;
    const fd = s?.financialData || {};
    const recentActions = (s?.upgradeDowngradeHistory?.history || []).slice(0, 10).map((/** @type {any} */ h) => ({
      date: h.epochGradeDate,
      firm: h.firm,
      toGrade: h.toGrade,
      fromGrade: h.fromGrade || undefined,
      action: h.action,
    }));
    return {
      symbol,
      consensus,
      targetMean: fd.targetMeanPrice,
      targetHigh: fd.targetHighPrice,
      targetLow: fd.targetLowPrice,
      numberOfAnalysts: fd.numberOfAnalystOpinions,
      recentActions,
    };
  },

  /**
   * @param {string} symbol
   * @param {{ count?: number }} [opts]
   */
  async news(symbol, { count = 20 } = {}) {
    const yahoo = await getYahooClient();
    const newsCount = Math.min(count, 50);
    const results = /** @type {any} */ (
      await yahoo.search(symbol, { quotesCount: 0, newsCount }, NO_VALIDATE)
    );
    const articles = (results.news || []).map((/** @type {any} */ n) => ({
      title: n.title,
      link: n.link,
      publisher: n.publisher,
      publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime).getTime() : undefined,
      thumbnail: pickBestThumbnail(n.thumbnail),
      relatedSymbols: [symbol],
    }));
    return { articles };
  },
};

export default yahooAdapter;
