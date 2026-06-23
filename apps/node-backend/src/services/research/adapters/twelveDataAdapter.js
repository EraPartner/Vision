/**
 * Twelve Data research adapter (ADR-079). Strong on quotes/charts.
 * Free tier: 8 req/min, 800 req/day. Key via TWELVE_DATA_API_KEY.
 *
 * Methods match the capability map's twelve_data routes (search/quote/chart) and
 * return the SAME normalized shapes as the Yahoo adapter. Shapes are per the
 * documented Twelve Data API and need live verification with a real key.
 */

import { getJson, num } from './httpClient.js';
import { providerKey } from '../providerKeys.js';

const BASE = 'https://api.twelvedata.com';

const RANGE_TO_OUTPUTSIZE = {
  '1d': 2, '5d': 7, '1mo': 23, '3mo': 66, '6mo': 130, '1y': 260, '2y': 520, '5y': 1300, max: 5000,
};

function key() {
  const k = providerKey('twelve_data');
  if (!k) throw new Error('TWELVE_DATA_API_KEY not configured');
  return k;
}

function assertOk(payload) {
  // Twelve Data signals failure with { status: 'error', code, message }.
  if (payload && payload.status === 'error') throw new Error(payload.message || 'twelve_data error');
  return payload;
}

const twelveDataAdapter = {
  key: 'twelve_data',

  async search(query) {
    const url = `${BASE}/symbol_search?symbol=${encodeURIComponent(query)}&outputsize=8&apikey=${key()}`;
    const data = assertOk(await getJson(url));
    const items = (data?.data || []).map((d) => ({
      symbol: d.symbol,
      name: d.instrument_name || d.symbol,
      type: d.instrument_type || 'UNKNOWN',
      exchange: d.exchange || '',
    }));
    return { items };
  },

  async quote(symbol) {
    const url = `${BASE}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${key()}`;
    const q = assertOk(await getJson(url));
    return {
      symbol: q.symbol || symbol,
      name: q.name || symbol,
      price: num(q.close),
      change: num(q.change),
      changePercent: num(q.percent_change),
      currency: q.currency,
      exchange: q.exchange,
      type: q.type,
      open: num(q.open),
      dayHigh: num(q.high),
      dayLow: num(q.low),
      prevClose: num(q.previous_close),
      volume: num(q.volume),
      avgVolume: num(q.average_volume),
      high52w: num(q.fifty_two_week?.high),
      low52w: num(q.fifty_two_week?.low),
    };
  },

  async chart(symbol, { range = '1mo' } = {}) {
    const outputsize = RANGE_TO_OUTPUTSIZE[range] ?? RANGE_TO_OUTPUTSIZE['1mo'];
    const url = `${BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${outputsize}&apikey=${key()}`;
    const data = assertOk(await getJson(url));
    // Twelve Data returns newest-first; the chart expects oldest-first.
    const points = (data?.values || [])
      .map((v) => ({
        time: Date.parse(`${v.datetime}T00:00:00Z`),
        close: num(v.close),
        high: num(v.high),
        low: num(v.low),
        volume: num(v.volume),
      }))
      .filter((p) => Number.isFinite(p.time) && p.close !== undefined)
      .reverse();
    return { symbol: data?.meta?.symbol || symbol, currency: data?.meta?.currency, points };
  },
};

export default twelveDataAdapter;
