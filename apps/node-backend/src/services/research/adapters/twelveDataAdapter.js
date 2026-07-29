/**
 * Twelve Data research adapter (ADR-079). Strong on quotes/charts.
 * Free tier: 8 req/min, 800 req/day. Key via TWELVE_DATA_API_KEY.
 *
 * Methods match the capability map's twelve_data routes (search/quote/chart) and
 * return the SAME normalized shapes as the Yahoo adapter. Shapes are per the
 * documented Twelve Data API and need live verification with a real key.
 */

import { z } from 'zod';
import { getJson } from './httpClient.js';
import { providerKey } from '../providerKeys.js';
import { looseArray, looseString, numish, parseOr } from './schemas.js';

const BASE = 'https://api.twelvedata.com';

// Response shapes (tolerant — see schemas.js). Twelve Data serializes all
// numbers as strings, hence numish everywhere.
const searchResponseSchema = z.looseObject({
  data: looseArray(z.looseObject({
    symbol: looseString,
    instrument_name: looseString,
    instrument_type: looseString,
    exchange: looseString,
  })),
});

const quoteResponseSchema = z.looseObject({
  symbol: looseString,
  name: looseString,
  close: numish,
  change: numish,
  percent_change: numish,
  currency: looseString,
  exchange: looseString,
  type: looseString,
  open: numish,
  high: numish,
  low: numish,
  previous_close: numish,
  volume: numish,
  average_volume: numish,
  fifty_two_week: z.looseObject({ high: numish, low: numish }).catch({}),
});

const timeSeriesResponseSchema = z.looseObject({
  meta: z.looseObject({ symbol: looseString, currency: looseString }).catch({}),
  values: looseArray(z.looseObject({
    datetime: looseString,
    close: numish,
    high: numish,
    low: numish,
    volume: numish,
  })),
});

const RANGE_TO_OUTPUTSIZE = Object.freeze({
  '1d': 2, '5d': 7, '1mo': 23, '3mo': 66, '6mo': 130, '1y': 260, '2y': 520, '5y': 1300, max: 5000,
});

function key() {
  const k = providerKey('twelve_data');
  if (!k) throw new Error('TWELVE_DATA_API_KEY not configured');
  return k;
}

/**
 * @param {unknown} payload raw JSON body — upstream shape is undocumented outside
 *   the happy path, so it is checked defensively rather than typed.
 * @returns {unknown}
 */
function assertOk(payload) {
  // Twelve Data signals failure with { status: 'error', code, message }.
  if (payload && typeof payload === 'object') {
    const p = /** @type {Record<string, unknown>} */ (payload);
    if (p.status === 'error') throw new Error(p.message ? String(p.message) : 'twelve_data error');
  }
  return payload;
}

const twelveDataAdapter = {
  key: 'twelve_data',

  /** @param {string} query */
  async search(query) {
    const url = `${BASE}/symbol_search?symbol=${encodeURIComponent(query)}&outputsize=8&apikey=${key()}`;
    const payload = assertOk(await getJson(url));
    const { data } = parseOr(searchResponseSchema, payload, { data: [] });
    const items = data.map((d) => ({
      symbol: d.symbol,
      name: d.instrument_name || d.symbol,
      type: d.instrument_type || 'UNKNOWN',
      exchange: d.exchange || '',
    }));
    return { items };
  },

  /** @param {string} symbol */
  async quote(symbol) {
    const url = `${BASE}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${key()}`;
    const payload = assertOk(await getJson(url));
    // Pre-zod, a null body threw on field access; keep throwing so the
    // aggregator still falls through to the next provider.
    if (payload == null) throw new Error('twelve_data: empty quote response');
    const q = parseOr(quoteResponseSchema, payload, { fifty_two_week: {} });
    return {
      symbol: q.symbol || symbol,
      name: q.name || symbol,
      price: q.close,
      change: q.change,
      changePercent: q.percent_change,
      currency: q.currency,
      exchange: q.exchange,
      type: q.type,
      open: q.open,
      dayHigh: q.high,
      dayLow: q.low,
      prevClose: q.previous_close,
      volume: q.volume,
      avgVolume: q.average_volume,
      high52w: q.fifty_two_week.high,
      low52w: q.fifty_two_week.low,
    };
  },

  /**
   * @param {string} symbol
   * @param {{ range?: string }} [opts]
   */
  async chart(symbol, { range = '1mo' } = {}) {
    const outputsize = RANGE_TO_OUTPUTSIZE[/** @type {keyof typeof RANGE_TO_OUTPUTSIZE} */ (range)]
      ?? RANGE_TO_OUTPUTSIZE['1mo'];
    const url = `${BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${outputsize}&apikey=${key()}`;
    const payload = assertOk(await getJson(url));
    const { meta, values } = parseOr(timeSeriesResponseSchema, payload, { meta: {}, values: [] });
    // Twelve Data returns newest-first; the chart expects oldest-first.
    const points = values
      .map((v) => ({
        time: Date.parse(`${v.datetime}T00:00:00Z`),
        close: v.close,
        high: v.high,
        low: v.low,
        volume: v.volume,
      }))
      .filter((p) => Number.isFinite(p.time) && p.close !== undefined)
      .reverse();
    return { symbol: meta.symbol || symbol, currency: meta.currency, points };
  },
};

export default twelveDataAdapter;
