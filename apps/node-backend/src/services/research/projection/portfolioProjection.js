/**
 * Portfolio value projection (Research Pillar C — ADR-081).
 *
 * Monte-Carlo projection of portfolio value forward. The design decouples the
 * two estimation problems:
 *
 *   - RISK structure (volatility, fat tails, autocorrelation) is estimated from
 *     the AGGREGATE portfolio daily-return history — which already embeds the
 *     realized cross-holding covariance — rather than from a fragile NxN matrix
 *     built on sparse held-asset history.
 *   - DRIFT (expected return) is a per-holding weighted blend of historical mean
 *     and forward-looking provider inputs (analyst 12m target-implied growth +
 *     dividend yield), so the user can dial how much the projection leans on
 *     forward expectations via `forwardBlend` ∈ [0,1].
 *
 * Two simulators share the drift: `parametric` (Gaussian monthly steps) and
 * `block_bootstrap` (stationary block resample of de-meaned daily residuals,
 * Politis–Romano) which preserves fat tails. Both reuse the seeded PRNG from the
 * cash-flow forecast engine, so a given (params, seed) is fully reproducible.
 *
 * Nothing is persisted — results are computed on demand (ADR-079 storage
 * boundary). All side-effecting dependencies are injected for testing.
 */

import { makeRng, gaussian } from '../../calculations/forecast/prng.js';
import { firstOfMonthYmd, todayAppDateString } from '../../../lib/timezone.js';
import { researchAggregator } from '../researchAggregator.js';
import {
  getPortfolioSummary,
  getSnapshots,
} from '../../portfolioPerformanceSnapshotService.js';
import { mean, stdev, quantile, clamp, flowAdjustedLogReturns } from './stats.js';

const TRADING_DAYS_PER_MONTH = 21;
const TRADING_DAYS_PER_YEAR = 252;

const DEFAULT_PATHS = 1000;
const MAX_PATHS = 5000;
const MAX_HORIZON_MONTHS = 600; // 50y ceiling
const MEAN_BLOCK_LENGTH = 5;

/** Equity-like asset classes that can carry analyst / dividend forward inputs. */
const FORWARD_ELIGIBLE = new Set(['stock', 'etf', 'stocks_etfs', 'equity', 'fund']);
/** Cap forward enrichment to the largest N holdings to bound provider-quota spend. */
const MAX_FORWARD_HOLDINGS = 25;
/** Sanity band on a holding's blended annual expected return (ADR-081: ±50%). */
const RETURN_CLAMP = 0.5;

const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Stationary block bootstrap (Politis–Romano): draw daily residuals, advancing
 * one step within a block and jumping to a fresh random index with probability
 * 1/meanBlockLength. Summing `n` daily residuals yields one period (e.g. month)
 * residual that preserves short-run autocorrelation and fat tails.
 */
function sumBootstrapResiduals(residuals, n, meanBlockLength, rng) {
  const L = residuals.length;
  const pNewBlock = 1 / meanBlockLength;
  let idx = Math.floor(rng() * L) % L;
  let sum = 0;
  for (let filled = 0; filled < n; filled++) {
    sum += residuals[idx];
    if (rng() < pNewBlock) idx = Math.floor(rng() * L) % L;
    else idx = (idx + 1) % L;
  }
  return sum;
}

/**
 * Forward-looking expected annual return for one holding, derived from the
 * research aggregator: analyst 12-month target vs. live price gives implied
 * price growth; fundamentals dividend yield adds the income leg. Returns
 * undefined when no usable forward signal exists (so the caller falls back to
 * the historical drift for that holding).
 */
async function forwardExpectedReturn(holding, aggregator) {
  const assetClass = String(holding.asset_class || holding.assetClass || '').toLowerCase();
  if (!FORWARD_ELIGIBLE.has(assetClass) || !holding.symbol) return undefined;

  const [quoteR, analystR, fundR] = await Promise.allSettled([
    aggregator.fetch('quote', { symbol: holding.symbol, assetClass: 'stock' }),
    aggregator.fetch('analyst', { symbol: holding.symbol, assetClass: 'stock' }),
    aggregator.fetch('fundamentals', { symbol: holding.symbol, assetClass: 'stock' }),
  ]);

  const data = (r) => (r.status === 'fulfilled' && r.value?.source !== 'unavailable' ? r.value.data : undefined);
  const quote = data(quoteR);
  const analyst = data(analystR);
  const fund = data(fundR);

  const price = Number(quote?.price);
  const targetMean = Number(analyst?.targetMean);
  // Implied 12m price growth is the dominant signal; without it there's no
  // forward view worth blending, so dividend yield alone does not qualify.
  if (!(price > 0) || !(targetMean > 0)) return undefined;

  const growth = targetMean / price - 1;
  const dividendYield = Number.isFinite(Number(fund?.dividendYield)) ? Number(fund.dividendYield) : undefined;
  const expectedAnnual = clamp(growth + (dividendYield ?? 0), -RETURN_CLAMP, RETURN_CLAMP);

  return { symbol: holding.symbol, expectedAnnual, growth, dividendYield, price, targetMean };
}

const defaultDeps = {
  getPortfolioSummary,
  getSnapshots,
  aggregator: researchAggregator,
  today: () => todayAppDateString(),
};

/**
 * Run a portfolio value projection.
 *
 * @param {object} input
 * @param {number} [input.horizonMonths=120]
 * @param {number} [input.monthlyContribution=0]
 * @param {number} [input.paths=1000]
 * @param {number} [input.forwardBlend=0]  0 = pure historical drift, 1 = pure forward
 * @param {'parametric'|'block_bootstrap'} [input.method='parametric']
 * @param {number} [input.targetValue]
 * @param {string} [input.currency='EUR']
 * @param {string} [input.seed]
 * @param {Partial<typeof defaultDeps>} [deps]
 */
export async function runPortfolioForecast(input = {}, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const currency = (input.currency || 'EUR').toUpperCase();
  const horizonMonths = clampInt(input.horizonMonths, 1, MAX_HORIZON_MONTHS, 120);
  const monthlyContribution = Number.isFinite(Number(input.monthlyContribution))
    ? Math.max(0, Number(input.monthlyContribution))
    : 0;
  const paths = clampInt(input.paths, 100, MAX_PATHS, DEFAULT_PATHS);
  const forwardBlend = clamp(Number.isFinite(Number(input.forwardBlend)) ? Number(input.forwardBlend) : 0, 0, 1);
  const method = input.method === 'block_bootstrap' ? 'block_bootstrap' : 'parametric';
  const targetValue = Number.isFinite(Number(input.targetValue)) && Number(input.targetValue) > 0
    ? Number(input.targetValue)
    : undefined;
  const seed = input.seed
    || `pf:${currency}:${horizonMonths}:${paths}:${method}:${forwardBlend}:${monthlyContribution}`;

  const summary = await d.getPortfolioSummary(currency);
  const startValue = Number(summary?.totals?.totalPortfolioValue) || 0;
  if (!(startValue > 0)) return { available: false, reason: 'no_holdings' };

  // "Net invested" is the capital actually contributed (cost basis), NOT current
  // market value — using startValue here would fold today's unrealized gains into
  // the break-even line and make probBelowInvested too pessimistic. Fall back to
  // market value only when cost basis is unavailable.
  const investedBasis = Number(summary?.totals?.totalInvested);
  const startInvested = investedBasis > 0 ? investedBasis : startValue;

  const snapshots = (await d.getSnapshots('2000-01-01', d.today(), currency)) || [];
  // Drift/vol come from FLOW-ADJUSTED returns: raw portfolio value rises on
  // deposits as well as market moves, so feeding raw value here would read every
  // contribution as investment return and inflate the projection (see stats.js).
  const { returns: logReturns, droppedDays: flowArtifactDays } = flowAdjustedLogReturns(
    snapshots.map((s) => Number(s.value)),
    snapshots.map((s) => Number(s.invested)),
  );
  if (logReturns.length < 2) {
    return { available: false, reason: 'insufficient_history', historyDays: logReturns.length };
  }

  const histDailyDrift = mean(logReturns);
  const dailyVol = stdev(logReturns);

  // ── Drift: per-holding weighted blend of historical and forward expectations ──
  let blendedDailyDrift = histDailyDrift;
  let forwardHoldings = [];
  if (forwardBlend > 0) {
    const holdings = (summary.summaries || []).filter((h) => Number(h.currentValue) > 0);
    const ranked = [...holdings]
      .sort((a, b) => Number(b.currentValue) - Number(a.currentValue))
      .slice(0, MAX_FORWARD_HOLDINGS);
    const resolved = await Promise.all(ranked.map((h) => forwardExpectedReturn(h, d.aggregator)));
    const byId = new Map();
    ranked.forEach((h, i) => { if (resolved[i]) byId.set(h.id, resolved[i]); });
    forwardHoldings = [...byId.values()];

    // Weighted forward daily drift across ALL holdings; holdings without a
    // forward signal contribute the historical drift, keeping Σweights = 1.
    let forwardDailyDrift = 0;
    for (const h of holdings) {
      const weight = Number(h.currentValue) / startValue;
      const fwd = byId.get(h.id);
      const holdingDailyDrift = fwd
        ? Math.log(1 + fwd.expectedAnnual) / TRADING_DAYS_PER_YEAR
        : histDailyDrift;
      forwardDailyDrift += weight * holdingDailyDrift;
    }
    blendedDailyDrift = forwardBlend * forwardDailyDrift + (1 - forwardBlend) * histDailyDrift;
  }

  const monthlyDrift = blendedDailyDrift * TRADING_DAYS_PER_MONTH;
  const monthlyVol = dailyVol * Math.sqrt(TRADING_DAYS_PER_MONTH);
  const residuals = method === 'block_bootstrap' ? logReturns.map((r) => r - histDailyDrift) : undefined;

  // ── Simulate ──
  const rng = makeRng(seed);
  const monthValues = Array.from({ length: horizonMonths }, () => new Array(paths));
  const finals = new Array(paths);
  for (let p = 0; p < paths; p++) {
    let v = startValue;
    for (let h = 0; h < horizonMonths; h++) {
      const logRet = method === 'block_bootstrap'
        ? monthlyDrift + sumBootstrapResiduals(residuals, TRADING_DAYS_PER_MONTH, MEAN_BLOCK_LENGTH, rng)
        : monthlyDrift + monthlyVol * gaussian(rng);
      v = v * Math.exp(logRet) + monthlyContribution;
      monthValues[h][p] = v;
    }
    finals[p] = v;
  }

  // ── Aggregate ──
  const today = d.today();
  const points = monthValues.map((vals, h) => {
    const sorted = vals.slice().sort((a, b) => a - b);
    return {
      monthIndex: h + 1,
      date: firstOfMonthYmd(today, h + 1),
      netInvested: round2(startInvested + monthlyContribution * (h + 1)),
      p10: round2(quantile(sorted, 10)),
      p25: round2(quantile(sorted, 25)),
      p50: round2(quantile(sorted, 50)),
      p75: round2(quantile(sorted, 75)),
      p90: round2(quantile(sorted, 90)),
    };
  });

  const sortedFinals = finals.slice().sort((a, b) => a - b);
  const totalContributions = monthlyContribution * horizonMonths;
  const netInvested = startInvested + totalContributions;
  const probBelowInvested = finals.filter((v) => v < netInvested).length / paths;
  const probTarget = targetValue ? finals.filter((v) => v >= targetValue).length / paths : undefined;

  return {
    available: true,
    currency,
    method,
    horizonMonths,
    paths,
    seed,
    historyDays: logReturns.length,
    flowArtifactDays,
    lowConfidence: logReturns.length < 60,
    startValue: round2(startValue),
    startInvested: round2(startInvested),
    monthlyContribution: round2(monthlyContribution),
    totalContributions: round2(totalContributions),
    netInvested: round2(netInvested),
    expectedAnnualReturn: round4(Math.exp(blendedDailyDrift * TRADING_DAYS_PER_YEAR) - 1),
    historicalAnnualReturn: round4(Math.exp(histDailyDrift * TRADING_DAYS_PER_YEAR) - 1),
    annualVolatility: round4(dailyVol * Math.sqrt(TRADING_DAYS_PER_YEAR)),
    forwardBlend,
    usedForward: forwardHoldings.length > 0,
    forwardHoldings: forwardHoldings.map((f) => ({
      symbol: f.symbol,
      expectedAnnual: round4(f.expectedAnnual),
      growth: round4(f.growth),
      dividendYield: f.dividendYield != null ? round4(f.dividendYield) : undefined,
    })),
    projected: {
      mean: round2(mean(finals)),
      p10: round2(quantile(sortedFinals, 10)),
      p25: round2(quantile(sortedFinals, 25)),
      p50: round2(quantile(sortedFinals, 50)),
      p75: round2(quantile(sortedFinals, 75)),
      p90: round2(quantile(sortedFinals, 90)),
    },
    probBelowInvested: round4(probBelowInvested),
    targetValue,
    probTarget: probTarget != null ? round4(probTarget) : undefined,
    points,
  };
}

export default { runPortfolioForecast };
