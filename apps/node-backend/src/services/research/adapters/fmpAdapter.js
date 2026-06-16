/**
 * Financial Modeling Prep (FMP) research adapter (ADR-079). Primary fundamentals.
 * Free tier: 250 req/day. Key via FMP_API_KEY.
 *
 * Uses FMP's current "stable" API (https://financialmodelingprep.com/stable).
 * FMP retired the legacy /api/v3 base for accounts not subscribed before
 * 2025-08-31, so the path-style v3 endpoints this adapter originally targeted now
 * fail (the failure surfaced as the admin health row "fmp: no fundamentals").
 * Stable takes the symbol as a query param and renamed several response fields
 * (mktCap → marketCap, changesPercentage → changePercentage, the ratios-ttm
 * pe/peg/debt/interest fields, and ROE moved to key-metrics-ttm). Field mappings
 * below were verified against live AAPL responses (2026-06-16).
 */

import { getJson, num } from './httpClient.js';
import { providerKey } from '../providerKeys.js';

const BASE = 'https://financialmodelingprep.com/stable';

function key() {
  const k = providerKey('fmp');
  if (!k) throw new Error('FMP_API_KEY not configured');
  return k;
}

const first = (arr) => (Array.isArray(arr) ? arr[0] : undefined);
const asArray = (value) => (Array.isArray(value) ? value : []);

const fmpAdapter = {
  key: 'fmp',

  async search(query) {
    const k = key();
    const enc = encodeURIComponent(query);
    // stable split the legacy /search into ticker (search-symbol) and company
    // name (search-name) lookups; query both and merge so either form resolves,
    // as the old combined endpoint did.
    const [bySymbol, byName] = await Promise.all([
      getJson(`${BASE}/search-symbol?query=${enc}&limit=8&apikey=${k}`).catch(() => []),
      getJson(`${BASE}/search-name?query=${enc}&limit=8&apikey=${k}`).catch(() => []),
    ]);
    const seen = new Set();
    const items = [];
    for (const r of [...asArray(bySymbol), ...asArray(byName)]) {
      if (!r?.symbol || seen.has(r.symbol)) continue;
      seen.add(r.symbol);
      items.push({
        symbol: r.symbol,
        name: r.name || r.symbol,
        type: 'stock',
        exchange: r.exchange || r.exchangeFullName || '',
      });
    }
    return { items };
  },

  async quote(symbol) {
    const q = first(await getJson(`${BASE}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${key()}`));
    if (!q) throw new Error('fmp: no quote');
    return {
      symbol: q.symbol || symbol,
      name: q.name || symbol,
      price: num(q.price),
      change: num(q.change),
      changePercent: num(q.changePercentage),
      currency: undefined, // FMP /quote omits currency
      exchange: q.exchange,
      open: num(q.open),
      dayHigh: num(q.dayHigh),
      dayLow: num(q.dayLow),
      prevClose: num(q.previousClose),
      volume: num(q.volume),
      avgVolume: num(q.averageVolume),
      high52w: num(q.yearHigh),
      low52w: num(q.yearLow),
    };
  },

  async fundamentals(symbol) {
    const k = key();
    const enc = encodeURIComponent(symbol);
    // profile + ratios are core; key-metrics + growth are best-effort enrichment
    // (each its own call → caught independently so one failure can't blank the
    // rest). Capture the core endpoints' error so the thrown message carries the
    // real HTTP status (shown as last_error on the admin health row) rather than
    // a bare "no fundamentals".
    /** @type {Error | undefined} */
    let coreError;
    const onCoreError = (err) => { if (!coreError) coreError = err; return undefined; };
    const [profile, ratios, keyMetrics, growth] = await Promise.all([
      getJson(`${BASE}/profile?symbol=${enc}&apikey=${k}`).then(first).catch(onCoreError),
      getJson(`${BASE}/ratios-ttm?symbol=${enc}&apikey=${k}`).then(first).catch(onCoreError),
      getJson(`${BASE}/key-metrics-ttm?symbol=${enc}&apikey=${k}`).then(first).catch(() => undefined),
      getJson(`${BASE}/financial-growth?symbol=${enc}&limit=1&apikey=${k}`).then(first).catch(() => undefined),
    ]);
    if (!profile && !ratios) {
      throw new Error(`fmp: no fundamentals${coreError ? ` (${coreError.message})` : ''}`);
    }
    return {
      symbol,
      name: profile?.companyName || symbol,
      currency: profile?.currency,
      sector: profile?.sector,
      marketCap: num(profile?.marketCap),
      pe: num(ratios?.priceToEarningsRatioTTM),
      forwardPE: undefined,
      pegRatio: num(ratios?.priceToEarningsGrowthRatioTTM),
      dividendYield: num(ratios?.dividendYieldTTM),
      payoutRatio: num(ratios?.dividendPayoutRatioTTM),
      eps: num(ratios?.netIncomePerShareTTM),
      beta: num(profile?.beta),
      priceToBook: num(ratios?.priceToBookRatioTTM),
      profitMargin: num(ratios?.netProfitMarginTTM),
      grossMargin: num(ratios?.grossProfitMarginTTM),
      operatingMargin: num(ratios?.operatingProfitMarginTTM),
      revenue: undefined,
      revenueGrowth: num(growth?.revenueGrowth),
      earningsGrowth: num(growth?.epsgrowth),
      returnOnEquity: num(keyMetrics?.returnOnEquityTTM),
      debtToEquity: num(ratios?.debtToEquityRatioTTM),
      currentRatio: num(ratios?.currentRatioTTM),
      quickRatio: num(ratios?.quickRatioTTM),
      interestCoverage: num(ratios?.interestCoverageRatioTTM),
      fcfYield: num(keyMetrics?.freeCashFlowYieldTTM),
    };
  },

  async analyst(symbol) {
    const k = key();
    const enc = encodeURIComponent(symbol);
    const [consensusTargets, grades, gradesConsensus] = await Promise.all([
      getJson(`${BASE}/price-target-consensus?symbol=${enc}&apikey=${k}`).then(first).catch(() => undefined),
      getJson(`${BASE}/grades?symbol=${enc}&limit=10&apikey=${k}`).catch(() => []),
      getJson(`${BASE}/grades-consensus?symbol=${enc}&apikey=${k}`).then(first).catch(() => undefined),
    ]);
    const recentActions = asArray(grades).slice(0, 10).map((g) => ({
      date: g.date ? Date.parse(g.date) : undefined,
      firm: g.gradingCompany,
      toGrade: g.newGrade,
      fromGrade: g.previousGrade,
      action: g.action,
    }));
    // stable exposes buy/hold/sell bucket counts (the v3 free tier did not).
    const consensus = gradesConsensus
      ? {
          strongBuy: num(gradesConsensus.strongBuy) ?? 0,
          buy: num(gradesConsensus.buy) ?? 0,
          hold: num(gradesConsensus.hold) ?? 0,
          sell: num(gradesConsensus.sell) ?? 0,
          strongSell: num(gradesConsensus.strongSell) ?? 0,
        }
      : undefined;
    const numberOfAnalysts = consensus
      ? consensus.strongBuy + consensus.buy + consensus.hold + consensus.sell + consensus.strongSell
      : undefined;
    return {
      symbol,
      consensus,
      targetMean: num(consensusTargets?.targetConsensus ?? consensusTargets?.targetMedian),
      targetHigh: num(consensusTargets?.targetHigh),
      targetLow: num(consensusTargets?.targetLow),
      numberOfAnalysts,
      recentActions,
    };
  },
};

export default fmpAdapter;
