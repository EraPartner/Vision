/**
 * Helpers for /portfolio-performance payload shaping:
 *   - snapshot row → client-facing shape
 *   - period filter + LTTB downsample
 *   - final payload assembly (metrics + heatmap + breakdown summary)
 */

import { computeMetrics, computeHeatmap, getBreakdownSummary } from '../../services/portfolioPerformanceSnapshotService.js';
import { downsampleLTTB } from '../../utils/downsample.js';
import { toDecimal, toNumber } from '../../lib/money.js';

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
  const metrics = computeMetrics(allSnapshots);
  const heatmap = computeHeatmap(allSnapshots);

  const periodFiltered = filterSnapshotsByPeriod(allSnapshots, period);
  const periodMapped = periodFiltered.map(mapPortfolioPerformanceSnapshot);
  const snapshots = downsampleLTTB(
    periodMapped,
    DOWNSAMPLE_THRESHOLD,
    (_item, i) => i,
    (item) => item.value,
  );

  const breakdownSummary = await getBreakdownSummary(targetCurrency);

  return {
    currency: targetCurrency,
    start_date: startDate,
    end_date: endDate,
    snapshots,
    metrics,
    heatmap,
    breakdownSummary,
  };
}
