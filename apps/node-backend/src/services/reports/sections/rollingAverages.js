/**
 * Section renderer: Rolling Averages.
 *
 * Compares current month's spending pace against the 6-month rolling average,
 * showing a pace indicator and key daily/monthly stats.
 */

import {
  escapeHtml,
  fmtCurrency,
  signClass,
} from '../sectionHelpers.js';

/**
 * @param {{ averages: object | null }} data
 * @param {{ currency: string }} opts
 * @returns {string}
 */
export function renderRollingAverages(data, { currency }) {
  const avg = data.averages;

  if (!avg) {
    return `
      <div class="page page-break">
        <div class="section-title">Rolling Averages</div>
        <div class="section-subtitle">Current month vs. 6-month average</div>
        <hr class="section-divider">
        <div class="empty-notice">No rolling average data available.</div>
      </div>`;
  }

  const past = avg.past_6_months ?? {};
  const current = avg.current_month ?? {};
  const comparison = avg.comparison ?? {};

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

  const kpiHtml = `
    <div class="kpi-grid" style="margin-bottom:28px">
      <div class="kpi-card">
        <div class="kpi-label">Avg Daily Spend (6mo)</div>
        <div class="kpi-value">${escapeHtml(fmtCurrency(past.avg_daily_spending ?? 0, currency))}</div>
        <div class="kpi-sub">${past.months_counted ?? 0} months</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg Monthly Spend (6mo)</div>
        <div class="kpi-value">${escapeHtml(fmtCurrency(avgMonthly, currency))}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">This Month So Far</div>
        <div class="kpi-value">${escapeHtml(fmtCurrency(current.total_spending ?? 0, currency))}</div>
        <div class="kpi-sub">${current.days_elapsed ?? 0} of ${current.days_in_month ?? 30} days</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Projected This Month</div>
        <div class="kpi-value ${projSc}">${escapeHtml(fmtCurrency(projected, currency))}</div>
        <div class="kpi-sub"><span class="badge ${paceBadgeClass}">${escapeHtml(paceLabel)}</span></div>
      </div>
    </div>`;

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

  return `
    <div class="page page-break">
      <div class="section-title">Rolling Averages</div>
      <div class="section-subtitle">Current month spending pace vs. 6-month rolling average</div>
      <hr class="section-divider">
      ${kpiHtml}
      ${statsHtml}
    </div>`;
}
