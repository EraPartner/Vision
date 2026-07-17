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
  fmtPct,
  kpiGrid,
  signClass,
} from '../sectionHelpers.js';
import { filterMonthsByPeriod } from '../dataFetcher.js';

/**
 * @param {{ monthly: object | null; filteredMonthly: object | null; exclusions?: { categoryIds: number[]; recipientIds: number[] } }} data
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

  const kpiHtml = kpiGrid([
    { label: 'Total Income', value: fmtCurrency(totalIncome, currency), cls: 'pos', sub: `${months.length} month${months.length !== 1 ? 's' : ''}` },
    { label: 'Total Expenses', value: fmtCurrency(Math.abs(totalSpending), currency), cls: 'neg' },
    { label: 'Net Position', value: fmtCurrency(netAmount, currency), cls: signClass(netAmount) },
    { label: 'Transactions', value: txCount.toLocaleString(), sub: `avg ${Math.round(txCount / Math.max(months.length, 1))}/mo` },
  ]);

  const avgHtml = kpiGrid([
    { label: 'Avg Monthly Income', value: fmtCurrency(avgMonthlyIncome, currency), cls: 'pos' },
    { label: 'Avg Monthly Expenses', value: fmtCurrency(avgMonthlySpending, currency), cls: 'neg' },
    { label: 'Avg Monthly Net', value: fmtCurrency(avgMonthlyIncome - avgMonthlySpending, currency), cls: signClass(avgMonthlyIncome - avgMonthlySpending) },
  ], { cols: 3, style: 'margin-top:0' });

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

  // Filter impact block — shown only when exclusions produced a filtered dataset
  let filterImpactHtml = '';
  if (data.filteredMonthly) {
    const fMonths = filterMonthsByPeriod(data.filteredMonthly?.months ?? [], period);
    const fIncome   = fMonths.reduce((s, m) => s + m.total_income, 0);
    const fSpending = fMonths.reduce((s, m) => s + m.total_spending, 0);
    const fNet      = fMonths.reduce((s, m) => s + m.net_amount, 0);
    const fTxCount  = fMonths.reduce((s, m) => s + m.transaction_count, 0);

    const diffIncome   = fIncome - totalIncome;
    const diffSpending = Math.abs(fSpending) - Math.abs(totalSpending);
    const diffNet      = fNet - netAmount;
    const diffTx       = fTxCount - txCount;

    const diffCell = (val, isCount = false) => {
      if (val === 0) return `<span class="badge badge-neutral">—</span>`;
      const cls = val > 0 ? 'badge-pos' : 'badge-neg';
      const sign = val > 0 ? '+' : '';
      const formatted = isCount
        ? `${sign}${val}`
        : `${sign}${fmtCurrency(val, currency)}`;
      const pct = isCount
        ? (txCount !== 0 ? ` (${fmtPct((val / txCount) * 100, true)})` : '')
        : '';
      return `<span class="badge ${cls}">${escapeHtml(formatted + pct)}</span>`;
    };

    const impactRows = [
      { label: 'Total Income',    filtered: fmtCurrency(fIncome, currency),              all: fmtCurrency(totalIncome, currency),              diffHtml: diffCell(diffIncome) },
      { label: 'Total Expenses',  filtered: fmtCurrency(Math.abs(fSpending), currency),  all: fmtCurrency(Math.abs(totalSpending), currency),  diffHtml: diffCell(diffSpending) },
      { label: 'Net Position',    filtered: fmtCurrency(fNet, currency),                 all: fmtCurrency(netAmount, currency),                diffHtml: diffCell(diffNet) },
      { label: 'Transactions',    filtered: fTxCount.toLocaleString(),                   all: txCount.toLocaleString(),                        diffHtml: diffCell(diffTx, true) },
    ].map(r => `
      <tr>
        <td>${escapeHtml(r.label)}</td>
        <td class="num">${escapeHtml(r.filtered)}</td>
        <td class="num">${escapeHtml(r.all)}</td>
        <td class="num">${r.diffHtml}</td>
      </tr>`).join('');

    filterImpactHtml = `
      <div class="filter-impact">
        <div class="filter-impact-title">Filter Impact</div>
        <div class="filter-impact-subtitle">Comparison of filtered view vs. all data for selected period</div>
        <table class="filter-impact-table">
          <thead>
            <tr>
              <th>Metric</th>
              <th class="num">With Filters</th>
              <th class="num">All Data</th>
              <th class="num">Difference</th>
            </tr>
          </thead>
          <tbody>${impactRows}</tbody>
        </table>
      </div>`;
  }

  return `
    <div class="page">
      <div class="section-title">Executive Summary</div>
      <div class="section-subtitle">Period overview — income, expenses &amp; net position</div>
      <hr class="section-divider">
      ${kpiHtml}
      ${avgHtml}
      ${tableHtml}
      ${filterImpactHtml}
    </div>`;
}
