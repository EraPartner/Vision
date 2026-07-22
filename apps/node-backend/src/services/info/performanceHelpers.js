/**
 * Helpers for /portfolio-performance payload shaping:
 *   - snapshot row → client-facing shape
 *   - period filter + LTTB downsample
 *   - final payload assembly (metrics + heatmap + breakdown summary)
 */

import { computeMetrics, computeHeatmap } from '../portfolioPerformanceSnapshotService.js';
import { toWireDate } from '../../lib/dateFormat.js';
import { getPortfolioSummary } from '../portfolio/portfolioSummaryService.js';
import { todayAppDateString, addDaysYmd } from '../../lib/timezone.js';
import { toYmd, sanitizeIsolatedValueSpikes } from '../../utils/portfolioMath.js';
import { toDecimal, toNumber } from '../../lib/money.js';
import {
  portfolioSummaryCache,
  PORTFOLIO_SUMMARY_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from './cache.js';

const PERIOD_OFFSETS = {
  '1m': 30,
  '3m': 90,
  '6m': 180,
  '1y': 365,
  '3y': 1095,
};

function parseSnapshotNumber(value) {
  return toNumber(toDecimal(value));
}

export function mapPortfolioPerformanceSnapshot(snapshot) {
  return {
    // DATE column: calendar-day string, not a raw pg Date.
    date: toWireDate(snapshot.snapshot_date),
    invested: parseSnapshotNumber(snapshot.invested),
    value: parseSnapshotNumber(snapshot.value),
    stocks_etfs_value: parseSnapshotNumber(snapshot.stocks_etfs_value),
    crypto_value: parseSnapshotNumber(snapshot.crypto_value),
    metals_value: parseSnapshotNumber(snapshot.metals_value),
    stocks_etfs_invested: parseSnapshotNumber(snapshot.stocks_etfs_invested),
    crypto_invested: parseSnapshotNumber(snapshot.crypto_invested),
    metals_invested: parseSnapshotNumber(snapshot.metals_invested),
    inflation_adjusted_value:
      parseSnapshotNumber(snapshot.inflation_adjusted_value) || parseSnapshotNumber(snapshot.value) || 0,
    gain_loss: parseSnapshotNumber(snapshot.gain_loss),
    return_pct: parseSnapshotNumber(snapshot.return_pct),
    // Omitted (not 0) when the FX-neutral series isn't available — predates
    // migration 0039 or the snapshot recompute that fills it.
    ...(snapshot.value_fx_neutral != null
      ? { value_fx_neutral: parseSnapshotNumber(snapshot.value_fx_neutral) }
      : {}),
  };
}

function filterSnapshotsByPeriod(snapshots, period) {
  if (!period || period === 'all' || !PERIOD_OFFSETS[period]) return snapshots;
  const daysBack = PERIOD_OFFSETS[period];
  const cutoffStr = addDaysYmd(todayAppDateString(), -daysBack);
  return snapshots.filter(s => {
    const date = toYmd(s.snapshot_date);
    return date >= cutoffStr;
  });
}

export async function buildPortfolioPerformancePayload(targetCurrency, startDate, endDate, allSnapshots, period) {
  // Smooth isolated one-day price needles (kinesis data-quality issue) BEFORE
  // metrics/heatmap/series, mirroring the protection the net-worth path already
  // has. The chart, heatmap month-ends, and metrics all consumed raw needles.
  const cleanSnapshots = /** @type {any} */ (sanitizeIsolatedValueSpikes(allSnapshots, 'value'));

  const snapshotMetrics = computeMetrics(cleanSnapshots);
  const heatmap = computeHeatmap(cleanSnapshots);

  const periodFiltered = filterSnapshotsByPeriod(cleanSnapshots, period);
  // No LTTB downsample: at daily granularity even 10y ≈ 3.6k points render as a
  // single SVG path fine, and LTTB *amplified* needles (it keeps max-area
  // points). Removing it also closes the shared-downsampler correctness bug's
  // backend impact. Full-resolution series instead.
  const snapshots = periodFiltered.map(mapPortfolioPerformanceSnapshot);

  // Realtime summary is the source of truth for current totals so the
  // performance headline cards always reconcile with the dashboard. The
  // historical-only fields (annualizedReturn, realReturnPct, cumulativeInflation)
  // still come from the snapshot timeseries since they need a date span.
  //
  // Routed through the shared portfolioSummaryCache (the same one the
  // /portfolio-summary route uses) so multiple performance period variants
  // and the dashboard all reuse one computation instead of recomputing the
  // full summary per request.
  const liveSummary = await resolveCacheWithInflight(portfolioSummaryCache, targetCurrency, {
    ttlMs: PORTFOLIO_SUMMARY_CACHE_TTL_MS,
    loader: () => getPortfolioSummary(targetCurrency),
  });
  const t = liveSummary.totals;
  const metrics = snapshotMetrics
    ? {
        ...snapshotMetrics,
        currentValue: t.totalPortfolioValue,
        totalInvested: t.totalInvested,
        totalGainLoss: t.totalGainLoss,
        totalReturnPct: t.totalReturnPct,
      }
    : null;

  return {
    currency: targetCurrency,
    start_date: startDate,
    end_date: endDate,
    snapshots,
    metrics,
    heatmap,
    breakdownSummary: liveSummary.summaries.map((s) => ({
      id: s.id,
      name: s.name,
      symbol: s.symbol,
      assetClass: s.asset_class,
      currency: s.originalCurrency,
      currentValue: s.currentValue,
      totalInvested: s.totalInvested,
      gainLoss: s.gainLoss,
      gainLossPercent: s.gainLossPercent,
      assetGain: s.assetGain,
      fxGain: s.fxGain,
      nativeCurrentValue: s.nativeCurrentValue,
      usedFallbackRate: s.usedFallbackRate,
    })),
    totals: liveSummary.totals,
  };
}
