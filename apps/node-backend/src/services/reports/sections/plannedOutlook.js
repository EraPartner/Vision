/**
 * Section renderer: Planned Outlook.
 *
 * Upcoming planned/recurring transactions for next month,
 * grouped by date with a summary KPI header.
 */

import {
  emptyNotice,
  emptySection,
  escapeHtml,
  fmtCurrency,
  fmtDate,
  kpiGrid,
  sectionPage,
  signClass,
} from '../sectionHelpers.js';

const MAX_DAYS = 31;

/**
 * @param {Pick<import('../dataFetcher.js').FinancialReportData, 'planned'>} data
 * @param {{ currency: string }} opts
 * @returns {string}
 */
export function renderPlannedOutlook(data, { currency }) {
  const planned = data.planned;

  if (!planned) {
    return emptySection({ title: 'Planned Outlook', subtitle: "Next month's expected transactions", message: 'No planned transaction data available.', pageBreak: true });
  }

  const { summary, daily_data = [], period_start, period_end } = planned;
  const periodLabel = period_start && period_end
    ? `${fmtDate(period_start)} – ${fmtDate(period_end)}`
    : 'Next month';

  // Summary KPIs
  const netSc = signClass(summary?.net_amount ?? 0);
  const kpiHtml = kpiGrid([
    { label: 'Expected Income', value: fmtCurrency(summary?.total_income ?? 0, currency), cls: 'pos' },
    { label: 'Expected Expenses', value: fmtCurrency(Math.abs(summary?.total_expenses ?? 0), currency), cls: 'neg' },
    { label: 'Net', value: fmtCurrency(summary?.net_amount ?? 0, currency), cls: netSc, sub: `${summary?.transaction_count ?? 0} planned txns` },
  ], { cols: 3, style: 'margin-bottom:24px' });

  // Daily groups
  const days = daily_data.slice(0, MAX_DAYS);

  if (!days.length) {
    return sectionPage({
      title: 'Planned Outlook',
      subtitle: periodLabel,
      pageBreak: true,
      content: `
        ${kpiHtml}
        ${emptyNotice('No planned transactions found.')}`,
    });
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

  return sectionPage({
    title: 'Planned Outlook',
    subtitle: periodLabel,
    pageBreak: true,
    content: `
      ${kpiHtml}
      ${dayGroups}`,
  });
}
