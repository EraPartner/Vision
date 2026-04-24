/**
 * Section renderer: Executive Summary.
 *
 * Shows a KPI grid with key financial totals for the requested period,
 * followed by a compact per-month breakdown table.
 */

import {
  escapeHtml,
  fmtCurrency,
  fmtMonthLabel,
  signClass,
} from '../sectionHelpers.js';
import { filterMonthsByPeriod } from '../dataFetcher.js';

/**
 * @param {{ monthly: object | null }} data
 * @param {{ currency: string; period: import('../dataFetcher.js').Period }} opts
 * @returns {string}  HTML string for this section
 */
export function renderExecutiveSummary(data, { currency, period }) {
  const months = filterMonthsByPeriod(data.monthly?.months ?? [], period);

  const totalIncome = months.reduce((s, m) => s + m.total_income, 0);
  const totalSpending = months.reduce((s, m) => s + m.total_spending, 0);
  const netAmount = months.reduce((s, m) => s + m.net_amount, 0);
  const txCount = months.reduce((s, m) => s + m.transaction_count, 0);
  const avgMonthlySpending = months.length > 0 ? Math.abs(totalSpending) / months.length : 0;
  const avgMonthlyIncome = months.length > 0 ? totalIncome / months.length : 0;

  const kpis = [
    { label: 'Total Income', value: fmtCurrency(totalIncome, currency), cls: 'pos', sub: `${months.length} month${months.length !== 1 ? 's' : ''}` },
    { label: 'Total Expenses', value: fmtCurrency(Math.abs(totalSpending), currency), cls: 'neg', sub: null },
    { label: 'Net Position', value: fmtCurrency(netAmount, currency), cls: signClass(netAmount), sub: null },
    { label: 'Transactions', value: txCount.toLocaleString(), cls: '', sub: `avg ${Math.round(txCount / Math.max(months.length, 1))}/mo` },
  ];

  const kpiHtml = kpis.map(k => `
    <div class="kpi-card">
      <div class="kpi-label">${escapeHtml(k.label)}</div>
      <div class="kpi-value ${k.cls}">${escapeHtml(k.value)}</div>
      ${k.sub ? `<div class="kpi-sub">${escapeHtml(k.sub)}</div>` : ''}
    </div>`).join('');

  const avgHtml = `
    <div class="kpi-grid kpi-grid-3" style="margin-top:0">
      <div class="kpi-card">
        <div class="kpi-label">Avg Monthly Income</div>
        <div class="kpi-value pos">${escapeHtml(fmtCurrency(avgMonthlyIncome, currency))}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg Monthly Expenses</div>
        <div class="kpi-value neg">${escapeHtml(fmtCurrency(avgMonthlySpending, currency))}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg Monthly Net</div>
        <div class="kpi-value ${signClass(avgMonthlyIncome - avgMonthlySpending)}">${escapeHtml(fmtCurrency(avgMonthlyIncome - avgMonthlySpending, currency))}</div>
      </div>
    </div>`;

  // Per-month table (most recent first, max 24 rows to fit on page)
  const tableRows = [...months].reverse().slice(0, 24).map(m => {
    const sc = signClass(m.net_amount);
    return `
      <tr>
        <td>${escapeHtml(fmtMonthLabel(m.year, m.month))}</td>
        <td class="num pos">${escapeHtml(fmtCurrency(m.total_income, currency))}</td>
        <td class="num neg">${escapeHtml(fmtCurrency(Math.abs(m.total_spending), currency))}</td>
        <td class="num ${sc}">${escapeHtml(fmtCurrency(m.net_amount, currency))}</td>
        <td class="num">${m.transaction_count}</td>
      </tr>`;
  }).join('');

  const tableHtml = months.length > 0 ? `
    <table class="data-table" style="margin-top:24px">
      <thead>
        <tr>
          <th>Month</th>
          <th class="num">Income</th>
          <th class="num">Expenses</th>
          <th class="num">Net</th>
          <th class="num">Txns</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>` : '<div class="empty-notice">No transactions in selected period.</div>';

  return `
    <div class="page">
      <div class="section-title">Executive Summary</div>
      <div class="section-subtitle">Period overview — income, expenses &amp; net position</div>
      <hr class="section-divider">
      <div class="kpi-grid">${kpiHtml}</div>
      ${avgHtml}
      ${tableHtml}
    </div>`;
}
