/**
 * Section renderer: Planned Outlook.
 *
 * Upcoming planned/recurring transactions for next month,
 * grouped by date with a summary KPI header.
 */

import {
  escapeHtml,
  fmtCurrency,
  fmtDate,
  signClass,
} from '../sectionHelpers.js';

const MAX_DAYS = 31;

/**
 * @param {{ planned: object | null }} data
 * @param {{ currency: string }} opts
 * @returns {string}
 */
export function renderPlannedOutlook(data, { currency }) {
  const planned = data.planned;

  if (!planned) {
    return `
      <div class="page page-break">
        <div class="section-title">Planned Outlook</div>
        <div class="section-subtitle">Next month's expected transactions</div>
        <hr class="section-divider">
        <div class="empty-notice">No planned transaction data available.</div>
      </div>`;
  }

  const { summary, daily_data = [], period_start, period_end } = planned;
  const periodLabel = period_start && period_end
    ? `${fmtDate(period_start)} – ${fmtDate(period_end)}`
    : 'Next month';

  // Summary KPIs
  const netSc = signClass(summary?.net_amount ?? 0);
  const kpiHtml = `
    <div class="kpi-grid kpi-grid-3" style="margin-bottom:24px">
      <div class="kpi-card">
        <div class="kpi-label">Expected Income</div>
        <div class="kpi-value pos">${escapeHtml(fmtCurrency(summary?.total_income ?? 0, currency))}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Expected Expenses</div>
        <div class="kpi-value neg">${escapeHtml(fmtCurrency(Math.abs(summary?.total_expenses ?? 0), currency))}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Net</div>
        <div class="kpi-value ${netSc}">${escapeHtml(fmtCurrency(summary?.net_amount ?? 0, currency))}</div>
        <div class="kpi-sub">${summary?.transaction_count ?? 0} planned txns</div>
      </div>
    </div>`;

  // Daily groups
  const days = daily_data.slice(0, MAX_DAYS);

  if (!days.length) {
    return `
      <div class="page page-break">
        <div class="section-title">Planned Outlook</div>
        <div class="section-subtitle">${escapeHtml(periodLabel)}</div>
        <hr class="section-divider">
        ${kpiHtml}
        <div class="empty-notice">No planned transactions found.</div>
      </div>`;
  }

  const dayGroups = days.map(day => {
    const txRows = (day.transactions ?? []).map(tx => {
      const amtSc = signClass(tx.amount);
      const catLabel = tx.category_name ? tx.category_name.replace(':', ' › ') : '';
      const recurBadge = tx.is_recurring
        ? `<span class="badge badge-neutral" style="margin-left:4px">recurring</span>`
        : '';
      return `
        <div class="planned-row">
          <span class="planned-row-name">${escapeHtml(tx.recipient_name ?? 'Unknown')}${recurBadge}</span>
          <span class="planned-row-cat">${escapeHtml(catLabel)}</span>
          <span class="planned-row-amt ${amtSc}">${escapeHtml(fmtCurrency(tx.amount, currency))}</span>
        </div>`;
    }).join('');

    return `
      <div class="planned-day">
        <div class="planned-day-header">${escapeHtml(fmtDate(day.date))}</div>
        ${txRows}
      </div>`;
  }).join('');

  return `
    <div class="page page-break">
      <div class="section-title">Planned Outlook</div>
      <div class="section-subtitle">${escapeHtml(periodLabel)}</div>
      <hr class="section-divider">
      ${kpiHtml}
      ${dayGroups}
    </div>`;
}
