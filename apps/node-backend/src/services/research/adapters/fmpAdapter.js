/**
 * Financial Modeling Prep (FMP) research adapter (ADR-079). Primary fundamentals.
 * Free tier: 250 req/day. Key via FMP_API_KEY.
 *
 * Methods match the capability map's fmp routes (search/quote/fundamentals/
 * analyst) and return the Yahoo-adapter shapes. Some analyst endpoints are
 * tier-gated; those are best-effort. Shapes per the documented FMP v3 API — needs
 * live verification with a real key.
 */

import { getJson, num } from './httpClient.js';
import { providerKey } from '../providerKeys.js';

const BASE = 'https://financialmodelingprep.com/api/v3';

function key() {
  const k = providerKey('fmp');
  if (!k) throw new Error('FMP_API_KEY not configured');
  return k;
}

const first = (arr) => (Array.isArray(arr) ? arr[0] : undefined);

const fmpAdapter = {
  key: 'fmp',

  async search(query) {
    const arr = await getJson(`${BASE}/search?query=${encodeURIComponent(query)}&limit=8&apikey=${key()}`);
    const items = (Array.isArray(arr) ? arr : []).map((r) => ({
      symbol: r.symbol,
      name: r.name || r.symbol,
      type: 'stock',
      exchange: r.exchangeShortName || r.stockExchange || '',
    }));
    return { items };
  },

  async quote(symbol) {
    const q = first(await getJson(`${BASE}/quote/${encodeURIComponent(symbol)}?apikey=${key()}`));
    if (!q) throw new Error('fmp: no quote');
    return {
      symbol: q.symbol || symbol,
      name: q.name || symbol,
      price: num(q.price),
      change: num(q.change),
      changePercent: num(q.changesPercentage),
      currency: undefined, // FMP /quote omits currency
      exchange: q.exchange,
      open: num(q.open),
      dayHigh: num(q.dayHigh),
      dayLow: num(q.dayLow),
      prevClose: num(q.previousClose),
      volume: num(q.volume),
      avgVolume: num(q.avgVolume),
      high52w: num(q.yearHigh),
      low52w: num(q.yearLow),
    };
  },

  async fundamentals(symbol) {
    const enc = encodeURIComponent(symbol);
    const [profile, ratios] = await Promise.all([
      getJson(`${BASE}/profile/${enc}?apikey=${key()}`).then(first).catch(() => undefined),
      getJson(`${BASE}/ratios-ttm/${enc}?apikey=${key()}`).then(first).catch(() => undefined),
    ]);
    if (!profile && !ratios) throw new Error('fmp: no fundamentals');
    return {
      symbol,
      name: profile?.companyName || symbol,
      currency: profile?.currency,
      marketCap: num(profile?.mktCap),
      pe: num(ratios?.peRatioTTM),
      forwardPE: undefined,
      dividendYield: num(ratios?.dividendYieldTTM),
      eps: num(ratios?.netIncomePerShareTTM),
      beta: num(profile?.beta),
      priceToBook: num(ratios?.priceToBookRatioTTM),
      profitMargin: num(ratios?.netProfitMarginTTM),
      revenue: undefined,
      returnOnEquity: num(ratios?.returnOnEquityTTM),
    };
  },

  async analyst(symbol) {
    const enc = encodeURIComponent(symbol);
    const [consensusTargets, grades] = await Promise.all([
      getJson(`${BASE}/price-target-consensus/${enc}?apikey=${key()}`).then(first).catch(() => undefined),
      getJson(`${BASE}/grade/${enc}?apikey=${key()}`).catch(() => []),
    ]);
    const recentActions = (Array.isArray(grades) ? grades : []).slice(0, 10).map((g) => ({
      date: g.date ? Date.parse(g.date) : undefined,
      firm: g.gradingCompany,
      toGrade: g.newGrade,
      fromGrade: g.previousGrade,
      action: undefined,
    }));
    return {
      symbol,
      consensus: undefined, // FMP free tier has no buy/hold/sell bucket counts
      targetMean: num(consensusTargets?.targetConsensus ?? consensusTargets?.targetMedian),
      targetHigh: num(consensusTargets?.targetHigh),
      targetLow: num(consensusTargets?.targetLow),
      numberOfAnalysts: undefined,
      recentActions,
    };
  },
};

export default fmpAdapter;
