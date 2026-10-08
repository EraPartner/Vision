/**
 * Section renderer: Rolling Averages.
 *
 * Compares current month's spending pace against the 6-month rolling average,
 * showing a pace indicator and key daily/monthly stats.
 */

import {
  emptySection,
  escapeHtml,
  fmtCurrency,
  kpiGrid,
  sectionPage,
  signClass,
} from '../sectionHelpers.ts';
import type { AveragesData, FinancialReportData } from '../dataFetcher.ts';

export function renderRollingAverages(
  data: Pick<FinancialReportData, 'averages'>,
  { currency }: { currency: string },
): string {
  const avg = data.averages;

  if (!avg) {
    return emptySection({ title: 'Rolling Averages', subtitle: 'Current month vs. 6-month average', message: 'No rolling average data available.', pageBreak: true });
  }

  // `?? {}` is defensive-only — `avg` (once truthy) always carries all three
  // sub-objects in practice (computeAverageVsCurrent always populates them).
  const past: Partial<AveragesData['past_6_months']> = avg.past_6_months ?? {};
  const current: Partial<AveragesData['current_month']> = avg.current_month ?? {};
  const comparison: Partial<AveragesData['comparison']> = avg.comparison ?? {};

  const pace = comparison.pace ?? null; // ratio: 1.0 = on track, >1 = over
  const variance = comparison.variance ?? 0;
  const projected = comparison.projected_monthly_total ?? 0;
  const avgMonthly = comparison.avg_monthly_spending ?? past.avg_monthly_spending ?? 0;

  // Pace badge
  let paceBadgeClass = 'badge-neutral';
  let paceLabel = 'On track';
  if (pace !== null) {
    if (pace > 1.15) { paceBadgeClass = 'badge-neg'; paceLabel = 'Over pace'; }
    else if (pace < 0.85) { paceBadgeClass = 'badge-pos'; paceLabel = 'Under pace'; }
    else { paceBadgeClass = 'badge-neutral'; paceLabel = 'On track'; }
  }

  const varSc = signClass(-variance); // positive variance = spending more = bad
  const projSc = projected > avgMonthly ? 'neg' : projected < avgMonthly ? 'pos' : '';

  const kpiHtml = kpiGrid([
    { label: 'Avg Daily Spend (6mo)', value: fmtCurrency(past.avg_daily_spending ?? 0, currency), sub: `${past.months_counted ?? 0} months` },
    { label: 'Avg Monthly Spend (6mo)', value: fmtCurrency(avgMonthly, currency) },
    { label: 'This Month So Far', value: fmtCurrency(current.total_spending ?? 0, currency), sub: `${current.days_elapsed ?? 0} of ${current.days_in_month ?? 30} days` },
    { label: 'Projected This Month', value: fmtCurrency(projected, currency), cls: projSc, subHtml: `<span class="badge ${paceBadgeClass}">${escapeHtml(paceLabel)}</span>` },
  ], { style: 'margin-bottom:28px' });

  const statsHtml = `
    <div style="max-width:400px">
      <div class="stat-row">
        <span class="stat-label">Projected vs. average</span>
        <span class="stat-value ${varSc}">${escapeHtml(fmtCurrency(variance, currency))} ${variance > 0 ? 'over' : variance < 0 ? 'under' : ''}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Pace ratio</span>
        <span class="stat-value">${pace !== null ? `${(pace * 100).toFixed(0)}%` : '—'}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Days elapsed</span>
        <span class="stat-value">${current.days_elapsed ?? 0} / ${current.days_in_month ?? 30}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Months in sample</span>
        <span class="stat-value">${past.months_counted ?? 0}</span>
      </div>
    </div>`;

  return sectionPage({
    title: 'Rolling Averages',
    subtitle: 'Current month spending pace vs. 6-month rolling average',
    pageBreak: true,
    content: `
      ${kpiHtml}
      ${statsHtml}`,
  });
}
