/**
 * Helpers for /portfolio-performance payload shaping:
 *   - snapshot row → client-facing shape
 *   - period filter at full daily resolution
 *   - final payload assembly (metrics + heatmap + breakdown summary)
 */

import {
  computeMetrics,
  computeHeatmap,
} from "../portfolioPerformanceSnapshotService.js";
import { toWireDate } from "../../lib/dateFormat.ts";
import { getPortfolioSummary } from "../portfolio/portfolioSummaryService.ts";
import { todayAppDateString, addDaysYmd } from "../../lib/timezone.ts";
import { toYmd } from "../calculations/portfolioMath.ts";
import { toDecimal, toNumber } from "../../lib/money.ts";
import {
  portfolioSummaryCache,
  PORTFOLIO_SUMMARY_CACHE_TTL_MS,
  resolveCacheWithInflight,
} from "./cache.ts";
import type { DecimalInput } from "../../lib/money.ts";
import type { PortfolioPerformanceSnapshotRow } from "../../types/rows.ts";

/**
 * The snapshot shape this module actually receives: `getSnapshots` in
 * portfolioPerformanceSnapshotService re-projects the raw row, dropping `id` /
 * `computed_at` / `cumulative_inflation` / `real_return_pct` and applying `??`
 * defaults — so `inflation_adjusted_value` may fall back to `value` and the
 * three `*_invested` columns may fall back to the string `'0'` on rows written
 * before those columns existed, keeping the NUMERIC-string contract uniform
 * with every other money field here. `value_fx_neutral` becomes `undefined`
 * (not null) when absent.
 */
export type PerformanceSnapshot = Pick<
  PortfolioPerformanceSnapshotRow,
  | "snapshot_date"
  | "invested"
  | "value"
  | "stocks_etfs_value"
  | "crypto_value"
  | "metals_value"
  | "cash_value"
  | "gain_loss"
  | "return_pct"
  | "currency"
> & {
  inflation_adjusted_value: string;
  stocks_etfs_invested: string;
  crypto_invested: string;
  metals_invested: string;
  value_fx_neutral?: string | undefined;
};

/**
 * A {@link PerformanceSnapshot} after `buildPortfolioPerformancePayload`
 * re-derived `gain_loss` / `return_pct` as numbers.
 */
type CleanPerformanceSnapshot = Omit<
  PerformanceSnapshot,
  "gain_loss" | "return_pct"
> & {
  gain_loss: number;
  return_pct: number;
};

/** Period key → lookback window in days. */
const PERIOD_OFFSETS: Record<string, number> = {
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
  "3y": 1095,
};

/** @param value a NUMERIC column (pg string), or a `??` fallback string */
function parseSnapshotNumber(value: DecimalInput): number {
  return toNumber(toDecimal(value));
}

/**
 * Snapshot row → client-facing shape: NUMERIC strings become numbers and the
 * DATE becomes a calendar-day string (`value_fx_neutral` is conditionally
 * spread in).
 */
export function mapPortfolioPerformanceSnapshot(
  snapshot: PerformanceSnapshot | CleanPerformanceSnapshot,
) {
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
      parseSnapshotNumber(snapshot.inflation_adjusted_value) ||
      parseSnapshotNumber(snapshot.value) ||
      0,
    gain_loss: parseSnapshotNumber(snapshot.gain_loss),
    return_pct: parseSnapshotNumber(snapshot.return_pct),
    // Omitted (not 0) when the FX-neutral series isn't available — predates
    // migration 0039 or the snapshot recompute that fills it.
    ...(snapshot.value_fx_neutral != null
      ? { value_fx_neutral: parseSnapshotNumber(snapshot.value_fx_neutral) }
      : {}),
  };
}

/**
 * Restrict a snapshot series to the trailing window named by `period`.
 * Unknown periods (including 'all') pass the series through unchanged.
 *
 * @param period one of PERIOD_OFFSETS' keys, or 'all'
 */
function filterSnapshotsByPeriod<
  S extends Pick<PerformanceSnapshot, "snapshot_date">,
>(snapshots: S[], period: string | null | undefined): S[] {
  if (!period || period === "all" || !PERIOD_OFFSETS[period]) return snapshots;
  const daysBack = PERIOD_OFFSETS[period];
  const cutoffStr = addDaysYmd(todayAppDateString(), -daysBack);
  return snapshots.filter((s) => {
    const date = toYmd(s.snapshot_date);
    return date >= cutoffStr;
  });
}

/**
 * Assemble the /portfolio-performance response: cleaned + period-filtered
 * series, snapshot-derived metrics overlaid with the live summary's current
 * totals, the heatmap, and the per-investment breakdown.
 *
 * `metrics`, `heatmap`, `breakdownSummary` and `totals` carry the shapes of
 * computeMetrics / computeHeatmap / getPortfolioSummary output.
 *
 * @param startDate 'YYYY-MM-DD'
 * @param endDate 'YYYY-MM-DD'
 * @param allSnapshots full stored series, oldest first
 * @param period one of PERIOD_OFFSETS' keys, or 'all'
 */
export async function buildPortfolioPerformancePayload(
  targetCurrency: string,
  startDate: string,
  endDate: string,
  allSnapshots: PerformanceSnapshot[],
  period: string | null | undefined,
) {
  // Snapshot storage already applies the decomposition-aware sanitizer before
  // computing derived fields. A second, value-only pass here used a different
  // rule: it flattened genuine one-day cash movements and could make value,
  // gain_loss, return_pct, and value_fx_neutral contradict each other. Treat the
  // persisted decomposition as authoritative and only re-derive the two fields
  // whose invariant is cheap to enforce at the response boundary.
  const cleanSnapshots = allSnapshots.map(
    (snapshot): CleanPerformanceSnapshot => {
      const value = toDecimal(snapshot.value);
      const invested = toDecimal(snapshot.invested);
      const gainLoss = value.minus(invested);
      return {
        ...snapshot,
        gain_loss: toNumber(gainLoss),
        return_pct: invested.gt(0)
          ? toNumber(gainLoss.div(invested).times(100))
          : 0,
      };
    },
  );

  const snapshotMetrics = computeMetrics(cleanSnapshots);
  const heatmap = computeHeatmap(cleanSnapshots);

  const periodFiltered = filterSnapshotsByPeriod(cleanSnapshots, period);
  // No LTTB downsample: at daily granularity even 10y ≈ 3.6k points render as a
  // single SVG path fine, and LTTB *amplified* needles (it keeps max-area
  // points). Removing it also closes the shared-downsampler correctness bug's
  // backend impact. Full-resolution series instead.
  const snapshots = periodFiltered.map((snapshot, index, filtered) => ({
    ...mapPortfolioPerformanceSnapshot(snapshot),
    // The endpoint intentionally preserves the newest stored point verbatim.
    // It may be stabilized only after a later snapshot provides both
    // neighbours required by the spike detector.
    is_provisional: index === filtered.length - 1,
  }));

  // Realtime summary is the source of truth for current totals so the
  // performance headline cards always reconcile with the dashboard. The
  // historical-only fields (annualizedReturn, realReturnPct, cumulativeInflation)
  // still come from the snapshot timeseries since they need a date span.
  //
  // Routed through the shared portfolioSummaryCache (the same one the
  // /portfolio-summary route uses) so multiple performance period variants
  // and the dashboard all reuse one computation instead of recomputing the
  // full summary per request.
  const liveSummary = await resolveCacheWithInflight(
    portfolioSummaryCache,
    targetCurrency,
    {
      ttlMs: PORTFOLIO_SUMMARY_CACHE_TTL_MS,
      loader: () => getPortfolioSummary(targetCurrency),
    },
  );
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
