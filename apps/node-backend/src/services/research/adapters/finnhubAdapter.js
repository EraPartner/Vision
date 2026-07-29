/**
 * Finnhub research adapter (ADR-079). Strong on news + US fundamentals.
 * Free tier: 60 req/min. Key via FINNHUB_API_KEY.
 *
 * Methods match the capability map's finnhub routes and return the Yahoo-adapter
 * shapes. Shapes are per the documented Finnhub API; some endpoints (candles,
 * price-target) are tier-gated and may 403 on free — those throw and the
 * aggregator falls through. Needs live verification with a real key.
 */

import { z } from 'zod';
import { getJson, num } from './httpClient.js';
import { providerKey } from '../providerKeys.js';
import { epochMsToUtcYmd } from '../../../lib/dateFormat.js';
import { looseArray, looseString, numish, parseOr } from './schemas.js';

const BASE = 'https://finnhub.io/api/v1';

// Response shapes (tolerant — see schemas.js).
const searchResponseSchema = z.looseObject({
  result: looseArray(z.looseObject({ symbol: looseString, description: looseString, type: looseString })),
});

const quoteResponseSchema = z.looseObject({
  c: numish, d: numish, dp: numish, o: numish, h: numish, l: numish, pc: numish,
});

const candleResponseSchema = z.looseObject({
  s: looseString,
  t: z.array(z.any()).catch([]),
  c: z.array(z.any()).catch([]),
  h: z.array(z.any()).catch([]),
  l: z.array(z.any()).catch([]),
  v: z.array(z.any()).catch([]),
});

// /stock/metric returns a flat map of ~dozens of metrics; the num()/pct()
// fallback chains below are domain normalization, so only the envelope is
// schema-validated and the leaves stay raw.
const metricResponseSchema = z.looseObject({
  metric: z.record(z.string(), z.any()).catch({}),
});

const recommendationRowSchema = z.looseObject({
  strongBuy: numish, buy: numish, hold: numish, sell: numish, strongSell: numish,
});

const priceTargetResponseSchema = z.looseObject({
  targetMean: numish, targetHigh: numish, targetLow: numish,
});

const newsRowSchema = z.looseObject({
  headline: looseString, url: looseString, source: looseString, datetime: numish, image: looseString,
});

const RANGE_TO_DAYS = Object.freeze({
  '1d': 1, '5d': 5, '1mo': 31, '3mo': 93, '6mo': 186, '1y': 366, '2y': 731, '5y': 1827, max: 7300,
});

function key() {
  const k = providerKey('finnhub');
  if (!k) throw new Error('FINNHUB_API_KEY not configured');
  return k;
}

const DAY_MS = 86_400_000;
const nowSec = () => Math.floor(Date.now() / 1000);
const ymd = epochMsToUtcYmd;

const finnhubAdapter = {
  key: 'finnhub',

  /** @param {string} query */
  async search(query) {
    const data = await getJson(`${BASE}/search?q=${encodeURIComponent(query)}&token=${key()}`);
    const { result } = parseOr(searchResponseSchema, data, { result: [] });
    const items = result.slice(0, 8).map((r) => ({
      symbol: r.symbol,
      name: r.description || r.symbol,
      type: r.type || 'UNKNOWN',
      exchange: '',
    }));
    return { items };
  },

  /** @param {string} symbol */
  async quote(symbol) {
    const data = await getJson(`${BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${key()}`);
    // Pre-zod, a null body threw on field access; keep throwing so the
    // aggregator still falls through to the next provider.
    if (data == null) throw new Error('finnhub: empty quote response');
    const q = parseOr(quoteResponseSchema, data, {});
    return {
      symbol,
      name: symbol, // /quote carries no name; cheap single-call path
      price: q.c,
      change: q.d,
      changePercent: q.dp,
      open: q.o,
      dayHigh: q.h,
      dayLow: q.l,
      prevClose: q.pc,
    };
  },

  /**
   * @param {string} symbol
   * @param {{ range?: string }} [opts]
   */
  async chart(symbol, { range = '1mo' } = {}) {
    const days = RANGE_TO_DAYS[/** @type {keyof typeof RANGE_TO_DAYS} */ (range)] ?? RANGE_TO_DAYS['1mo'];
    const to = nowSec();
    const from = to - days * 86_400;
    const c = parseOr(
      candleResponseSchema,
      await getJson(
        `${BASE}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${key()}`,
      ),
      undefined,
    );
    if (c?.s !== 'ok') {
      return { symbol, currency: /** @type {string | undefined} */ (undefined), points: [] };
    }
    const points = c.t.map((ts, i) => ({
      time: ts * 1000,
      close: num(c.c[i]),
      high: num(c.h[i]),
      low: num(c.l[i]),
      volume: num(c.v[i]),
    }));
    return { symbol, currency: /** @type {string | undefined} */ (undefined), points };
  },

  /** @param {string} symbol */
  async fundamentals(symbol) {
    const data = await getJson(`${BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${key()}`);
    const { metric: m } = parseOr(metricResponseSchema, data, { metric: {} });
    // Finnhub reports most ratios as percentages (e.g. margins, growth, yield);
    // normalize those to fractions so they match the cross-provider contract.
    /** @param {unknown} v */
    const pct = (v) => { const n = num(v); return n == null ? undefined : n / 100; };
    return {
      symbol,
      name: symbol,
      currency: /** @type {string | undefined} */ (undefined),
      marketCap: num(m.marketCapitalization), // reported in millions by Finnhub
      pe: num(m.peTTM ?? m.peBasicExclExtraTTM),
      forwardPE: /** @type {number | undefined} */ (undefined),
      pegRatio: num(m.pegTTM),
      dividendYield: pct(m.dividendYieldIndicatedAnnual),
      payoutRatio: pct(m.payoutRatioTTM ?? m.payoutRatioAnnual),
      eps: num(m.epsTTM),
      beta: num(m.beta),
      priceToBook: num(m.pbAnnual ?? m.pbQuarterly),
      profitMargin: pct(m.netProfitMarginTTM),
      grossMargin: pct(m.grossMarginTTM),
      operatingMargin: pct(m.operatingMarginTTM),
      revenue: num(m.revenuePerShareTTM),
      revenueGrowth: pct(m.revenueGrowthTTMYoy ?? m.revenueGrowthQuarterlyYoy),
      earningsGrowth: pct(m.epsGrowthTTMYoy),
      returnOnEquity: pct(m.roeTTM),
      debtToEquity: num(m['totalDebt/totalEquityAnnual'] ?? m['totalDebt/totalEquityQuarterly']),
      currentRatio: num(m.currentRatioAnnual ?? m.currentRatioQuarterly),
      quickRatio: num(m.quickRatioAnnual ?? m.quickRatioQuarterly),
      interestCoverage: num(m.netInterestCoverageTTM ?? m.netInterestCoverageAnnual),
    };
  },

  /** @param {string} symbol */
  async analyst(symbol) {
    const recs = await getJson(`${BASE}/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${key()}`);
    const latestRaw = parseOr(z.array(z.any()), recs, [])[0];
    // Truthiness on the RAW row so a malformed-but-present bucket still yields
    // zeroed counts, exactly as the old `?? 0` fallbacks did.
    const latest = latestRaw ? parseOr(recommendationRowSchema, latestRaw, {}) : undefined;
    const consensus = latest
      ? {
          strongBuy: latest.strongBuy ?? 0,
          buy: latest.buy ?? 0,
          hold: latest.hold ?? 0,
          sell: latest.sell ?? 0,
          strongSell: latest.strongSell ?? 0,
        }
      : undefined;
    // Price targets are tier-gated; best-effort (keep the empty default on failure).
    let targetsRaw;
    try {
      targetsRaw = await getJson(`${BASE}/stock/price-target?symbol=${encodeURIComponent(symbol)}&token=${key()}`);
    } catch {
      // not available on this tier
    }
    const targets = parseOr(priceTargetResponseSchema, targetsRaw, {});
    const numberOfAnalysts = consensus
      ? consensus.strongBuy + consensus.buy + consensus.hold + consensus.sell + consensus.strongSell
      : undefined;
    return {
      symbol,
      consensus,
      targetMean: targets.targetMean,
      targetHigh: targets.targetHigh,
      targetLow: targets.targetLow,
      numberOfAnalysts,
      recentActions: /** @type {unknown[]} */ ([]),
    };
  },

  /**
   * @param {string} symbol
   * @param {{ count?: number }} [opts]
   */
  async news(symbol, { count = 20 } = {}) {
    const to = Date.now();
    const from = to - 30 * DAY_MS;
    const arr = await getJson(
      `${BASE}/company-news?symbol=${encodeURIComponent(symbol)}&from=${ymd(from)}&to=${ymd(to)}&token=${key()}`,
    );
    const articles = parseOr(looseArray(newsRowSchema), arr, []).slice(0, count).map((n) => ({
      title: n.headline,
      link: n.url,
      publisher: n.source,
      publishedAt: n.datetime ? n.datetime * 1000 : undefined,
      thumbnail: n.image || undefined,
      relatedSymbols: [symbol],
    }));
    return { articles };
  },
};

export default finnhubAdapter;
