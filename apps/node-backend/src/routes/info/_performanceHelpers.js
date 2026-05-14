/**
 * Helpers for /portfolio-performance payload shaping:
 *   - snapshot row → client-facing shape
 *   - period filter + LTTB downsample
 *   - final payload assembly (metrics + heatmap + breakdown summary)
 */

import { computeMetrics, computeHeatmap } from '../../services/portfolioPerformanceSnapshotService.js';
import { getPortfolioSummary } from '../../services/portfolio/portfolioSummaryService.js';
import { downsampleLTTB } from '../../utils/downsample.js';
import { toDecimal, toNumber } from '../../lib/money.js';
import {
  portfolioSummaryCache,
  PORTFOLIO_SUMMARY_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from './_cache.js';

const DOWNSAMPLE_THRESHOLD = 400;

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
    date: snapshot.snapshot_date,
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
  };
}

function filterSnapshotsByPeriod(snapshots, period) {
  if (!period || period === 'all' || !PERIOD_OFFSETS[period]) return snapshots;
  const daysBack = PERIOD_OFFSETS[period];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return snapshots.filter(s => {
    const date = typeof s.snapshot_date === 'string' ? s.snapshot_date : s.snapshot_date.toISOString().slice(0, 10);
    return date >= cutoffStr;
  });
}

export async function buildPortfolioPerformancePayload(targetCurrency, startDate, endDate, allSnapshots, period) {
  const snapshotMetrics = computeMetrics(allSnapshots);
  const heatmap = computeHeatmap(allSnapshots);

  const periodFiltered = filterSnapshotsByPeriod(allSnapshots, period);
  const periodMapped = periodFiltered.map(mapPortfolioPerformanceSnapshot);
  const snapshots = downsampleLTTB(
    periodMapped,
    DOWNSAMPLE_THRESHOLD,
    (_item, i) => i,
    (item) => item.value,
  );

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
    })),
    totals: liveSummary.totals,
  };
}
