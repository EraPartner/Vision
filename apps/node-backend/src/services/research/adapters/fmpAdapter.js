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

import { z } from 'zod';
import { getJson } from './httpClient.js';
import { providerKey } from '../providerKeys.js';
import { looseArray, looseString, numish, parseOr } from './schemas.js';

const BASE = 'https://financialmodelingprep.com/stable';

function key() {
  const k = providerKey('fmp');
  if (!k) throw new Error('FMP_API_KEY not configured');
  return k;
}

/** @param {unknown} arr */
const first = (arr) => (Array.isArray(arr) ? arr[0] : undefined);

// Response row shapes (tolerant — see schemas.js). FMP wraps everything in
// arrays; rows are validated after the existing first()/emptiness checks so
// the "no quote"/"no fundamentals" throws keep firing on the same inputs.
const searchRowSchema = z.looseObject({
  symbol: looseString,
  name: looseString,
  exchange: looseString,
  exchangeFullName: looseString,
});

const quoteRowSchema = z.looseObject({
  symbol: looseString,
  name: looseString,
  price: numish,
  change: numish,
  changePercentage: numish,
  exchange: looseString,
  open: numish,
  dayHigh: numish,
  dayLow: numish,
  previousClose: numish,
  volume: numish,
  averageVolume: numish,
  yearHigh: numish,
  yearLow: numish,
});

const profileRowSchema = z.looseObject({
  companyName: looseString,
  currency: looseString,
  sector: looseString,
  marketCap: numish,
  beta: numish,
});

const ratiosRowSchema = z.looseObject({
  priceToEarningsRatioTTM: numish,
  priceToEarningsGrowthRatioTTM: numish,
  dividendYieldTTM: numish,
  dividendPayoutRatioTTM: numish,
  netIncomePerShareTTM: numish,
  priceToBookRatioTTM: numish,
  netProfitMarginTTM: numish,
  grossProfitMarginTTM: numish,
  operatingProfitMarginTTM: numish,
  debtToEquityRatioTTM: numish,
  currentRatioTTM: numish,
  quickRatioTTM: numish,
  interestCoverageRatioTTM: numish,
});

const keyMetricsRowSchema = z.looseObject({
  returnOnEquityTTM: numish,
  freeCashFlowYieldTTM: numish,
});

const growthRowSchema = z.looseObject({
  revenueGrowth: numish,
  epsgrowth: numish,
});

const targetConsensusRowSchema = z.looseObject({
  targetConsensus: numish,
  targetMedian: numish,
  targetHigh: numish,
  targetLow: numish,
});

const gradeRowSchema = z.looseObject({
  date: looseString,
  gradingCompany: looseString,
  newGrade: looseString,
  previousGrade: looseString,
  action: looseString,
});

const gradesConsensusRowSchema = z.looseObject({
  strongBuy: numish,
  buy: numish,
  hold: numish,
  sell: numish,
  strongSell: numish,
});

const fmpAdapter = {
  key: 'fmp',

  /** @param {string} query */
  async search(query) {
    const k = key();
    const enc = encodeURIComponent(query);
    // stable split the legacy /search into ticker (search-symbol) and company
    // name (search-name) lookups; query both and merge so either form resolves,
    // as the old combined endpoint did.
    const [bySymbol, byName] = await Promise.all([
      getJson(`${BASE}/search-symbol?query=${enc}&limit=8&apikey=${k}`).catch(() => /** @type {unknown[]} */ ([])),
      getJson(`${BASE}/search-name?query=${enc}&limit=8&apikey=${k}`).catch(() => /** @type {unknown[]} */ ([])),
    ]);
    const rows = [
      ...parseOr(looseArray(searchRowSchema), bySymbol, []),
      ...parseOr(looseArray(searchRowSchema), byName, []),
    ];
    const seen = new Set();
    const items = [];
    for (const r of rows) {
      if (!r.symbol || seen.has(r.symbol)) continue;
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

  /** @param {string} symbol */
  async quote(symbol) {
    const raw = first(await getJson(`${BASE}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${key()}`));
    if (!raw) throw new Error('fmp: no quote');
    const q = parseOr(quoteRowSchema, raw, {});
    return {
      symbol: q.symbol || symbol,
      name: q.name || symbol,
      price: q.price,
      change: q.change,
      changePercent: q.changePercentage,
      currency: /** @type {string | undefined} */ (undefined), // FMP /quote omits currency
      exchange: q.exchange,
      open: q.open,
      dayHigh: q.dayHigh,
      dayLow: q.dayLow,
      prevClose: q.previousClose,
      volume: q.volume,
      avgVolume: q.averageVolume,
      high52w: q.yearHigh,
      low52w: q.yearLow,
    };
  },

  /** @param {string} symbol */
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
    /**
     * @param {Error} err
     * @returns {undefined}
     */
    const onCoreError = (err) => { if (!coreError) coreError = err; return undefined; };
    const [profileRaw, ratiosRaw, keyMetricsRaw, growthRaw] = await Promise.all([
      getJson(`${BASE}/profile?symbol=${enc}&apikey=${k}`).then(first).catch(onCoreError),
      getJson(`${BASE}/ratios-ttm?symbol=${enc}&apikey=${k}`).then(first).catch(onCoreError),
      getJson(`${BASE}/key-metrics-ttm?symbol=${enc}&apikey=${k}`).then(first).catch(() => /** @type {unknown} */ (undefined)),
      getJson(`${BASE}/financial-growth?symbol=${enc}&limit=1&apikey=${k}`).then(first).catch(() => /** @type {unknown} */ (undefined)),
    ]);
    if (!profileRaw && !ratiosRaw) {
      throw new Error(`fmp: no fundamentals${coreError ? ` (${coreError.message})` : ''}`);
    }
    const profile = parseOr(profileRowSchema, profileRaw, undefined);
    const ratios = parseOr(ratiosRowSchema, ratiosRaw, undefined);
    const keyMetrics = parseOr(keyMetricsRowSchema, keyMetricsRaw, undefined);
    const growth = parseOr(growthRowSchema, growthRaw, undefined);
    return {
      symbol,
      name: profile?.companyName || symbol,
      currency: profile?.currency,
      sector: profile?.sector,
      marketCap: profile?.marketCap,
      pe: ratios?.priceToEarningsRatioTTM,
      forwardPE: /** @type {number | undefined} */ (undefined),
      pegRatio: ratios?.priceToEarningsGrowthRatioTTM,
      dividendYield: ratios?.dividendYieldTTM,
      payoutRatio: ratios?.dividendPayoutRatioTTM,
      eps: ratios?.netIncomePerShareTTM,
      beta: profile?.beta,
      priceToBook: ratios?.priceToBookRatioTTM,
      profitMargin: ratios?.netProfitMarginTTM,
      grossMargin: ratios?.grossProfitMarginTTM,
      operatingMargin: ratios?.operatingProfitMarginTTM,
      revenue: /** @type {number | undefined} */ (undefined),
      revenueGrowth: growth?.revenueGrowth,
      earningsGrowth: growth?.epsgrowth,
      returnOnEquity: keyMetrics?.returnOnEquityTTM,
      debtToEquity: ratios?.debtToEquityRatioTTM,
      currentRatio: ratios?.currentRatioTTM,
      quickRatio: ratios?.quickRatioTTM,
      interestCoverage: ratios?.interestCoverageRatioTTM,
      fcfYield: keyMetrics?.freeCashFlowYieldTTM,
    };
  },

  /** @param {string} symbol */
  async analyst(symbol) {
    const k = key();
    const enc = encodeURIComponent(symbol);
    const [consensusTargetsRaw, gradesRaw, gradesConsensusRaw] = await Promise.all([
      getJson(`${BASE}/price-target-consensus?symbol=${enc}&apikey=${k}`).then(first).catch(() => /** @type {unknown} */ (undefined)),
      getJson(`${BASE}/grades?symbol=${enc}&limit=10&apikey=${k}`).catch(() => /** @type {unknown[]} */ ([])),
      getJson(`${BASE}/grades-consensus?symbol=${enc}&apikey=${k}`).then(first).catch(() => /** @type {unknown} */ (undefined)),
    ]);
    const consensusTargets = parseOr(targetConsensusRowSchema, consensusTargetsRaw, undefined);
    const recentActions = parseOr(looseArray(gradeRowSchema), gradesRaw, []).slice(0, 10).map((g) => ({
      date: g.date ? Date.parse(g.date) : undefined,
      firm: g.gradingCompany,
      toGrade: g.newGrade,
      fromGrade: g.previousGrade,
      action: g.action,
    }));
    // stable exposes buy/hold/sell bucket counts (the v3 free tier did not).
    // Truthiness is checked on the RAW value so a malformed-but-present block
    // still yields zeroed buckets, exactly as the old num()-guards did.
    const gradesConsensus = gradesConsensusRaw
      ? parseOr(gradesConsensusRowSchema, gradesConsensusRaw, {})
      : undefined;
    const consensus = gradesConsensus
      ? {
          strongBuy: gradesConsensus.strongBuy ?? 0,
          buy: gradesConsensus.buy ?? 0,
          hold: gradesConsensus.hold ?? 0,
          sell: gradesConsensus.sell ?? 0,
          strongSell: gradesConsensus.strongSell ?? 0,
        }
      : undefined;
    const numberOfAnalysts = consensus
      ? consensus.strongBuy + consensus.buy + consensus.hold + consensus.sell + consensus.strongSell
      : undefined;
    return {
      symbol,
      consensus,
      targetMean: consensusTargets?.targetConsensus ?? consensusTargets?.targetMedian,
      targetHigh: consensusTargets?.targetHigh,
      targetLow: consensusTargets?.targetLow,
      numberOfAnalysts,
      recentActions,
    };
  },
};

export default fmpAdapter;
