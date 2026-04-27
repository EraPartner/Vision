/**
 * Section renderer: Top Recipients.
 *
 * Horizontal bar chart of the top 10 merchants by total spend (all time),
 * with a ranked table. Includes month-over-month alerts when available.
 */

import {
  escapeHtml,
  fmtCurrency,
  fmtDate,
  fmtPct,
  svgHorizontalBars,
} from '../sectionHelpers.js';

const MAX_CHART_ITEMS = 10;
const MAX_TABLE_ROWS = 15;
const MAX_MOM_ROWS = 8;

/**
 * @param {{ recipients: { topMerchants: object[]; monthOverMonth: object[] } | null; exclusions?: { categoryIds: number[]; recipientIds: number[] } }} data
 * @param {{ currency: string }} opts
 * @returns {string}
 */
export function renderTopRecipients(data, { currency }) {
  const topMerchants = data.recipients?.topMerchants ?? [];
  const monthOverMonth = data.recipients?.monthOverMonth ?? [];
  const excludedRecipientIds = data.exclusions?.recipientIds ?? [];
  const hasExclusions = excludedRecipientIds.length > 0;

  if (!topMerchants.length) {
    return `
      <div class="page page-break">
        <div class="section-title">Top Recipients</div>
        <div class="section-subtitle">Merchants by total spend</div>
        <hr class="section-divider">
        <div class="empty-notice">No recipient data available.</div>
      </div>`;
  }

  // Client-side filtered list when exclusions are active
  const excludedIdSet = new Set(excludedRecipientIds);
  const filteredMerchants = hasExclusions
    ? topMerchants.filter(m => !excludedIdSet.has(m.recipientId))
    : null;

  // Build chart section — single chart normally, dual comparison when filters active
  let chartHtml;
  if (hasExclusions && filteredMerchants) {
    const allItems = topMerchants.slice(0, MAX_CHART_ITEMS).map(m => ({
      label: m.name ?? `Recipient ${m.recipientId}`,
      value: m.totalSpend,
      fmtValue: fmtCurrency(m.totalSpend, currency),
    }));
    const filteredItems = filteredMerchants.slice(0, MAX_CHART_ITEMS).map(m => ({
      label: m.name ?? `Recipient ${m.recipientId}`,
      value: m.totalSpend,
      fmtValue: fmtCurrency(m.totalSpend, currency),
    }));
    chartHtml = `
      <div class="chart-pair">
        <div>
          <div class="chart-pair-label">With active filters (${filteredMerchants.length} recipient${filteredMerchants.length === 1 ? '' : 's'})</div>
          ${svgHorizontalBars(filteredItems)}
        </div>
        <div>
          <div class="chart-pair-label">All data (${topMerchants.length} recipient${topMerchants.length === 1 ? '' : 's'})</div>
          ${svgHorizontalBars(allItems)}
        </div>
      </div>`;
  } else {
    const chartItems = topMerchants.slice(0, MAX_CHART_ITEMS).map(m => ({
      label: m.name ?? `Recipient ${m.recipientId}`,
      value: m.totalSpend,
      fmtValue: fmtCurrency(m.totalSpend, currency),
    }));
    chartHtml = `<div class="chart-wrap">${svgHorizontalBars(chartItems)}</div>`;
  }

  // Ranked table — filtered rows when exclusions active
  const tableSource = filteredMerchants ?? topMerchants;
  const tableRows = tableSource.slice(0, MAX_TABLE_ROWS).map((m, i) => {
    const name = m.name ?? `Recipient ${m.recipientId}`;
    const avg = m.avgAmount ?? (m.transactionCount > 0 ? m.totalSpend / m.transactionCount : 0);
    return `
      <tr>
        <td style="color:hsl(var(--muted));font-size:10px">${i + 1}</td>
        <td>${escapeHtml(name)}</td>
        <td class="num neg">${escapeHtml(fmtCurrency(m.totalSpend, currency))}</td>
        <td class="num">${m.transactionCount}</td>
        <td class="num">${escapeHtml(fmtCurrency(avg, currency))}</td>
        <td style="font-size:10px;color:hsl(var(--muted))">${escapeHtml(fmtDate(m.lastSeen))}</td>
      </tr>`;
  }).join('');

  const topTableNote = tableSource.length > MAX_TABLE_ROWS
    ? `<p style="font-size:10px;color:hsl(var(--muted));margin-top:8px">Showing top ${MAX_TABLE_ROWS} of ${tableSource.length} recipients.</p>`
    : '';

  const filterNoticeHtml = hasExclusions
    ? `<div class="filter-notice">Table shows ${filteredMerchants?.length ?? 0} recipients matching active filters. ${excludedRecipientIds.length} recipient${excludedRecipientIds.length === 1 ? '' : 's'} excluded — see "All data" chart above.</div>`
    : '';

  // Month-over-month table (optional — only rendered when data present)
  let momHtml = '';
  if (monthOverMonth.length > 0) {
    const momRows = monthOverMonth.slice(0, MAX_MOM_ROWS).map(m => {
      const delta = m.changePercent ?? 0;
      const badgeCls = delta > 10 ? 'badge-neg' : delta < -10 ? 'badge-pos' : 'badge-neutral';
      const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '—';
      return `
        <tr>
          <td>${escapeHtml(m.name ?? '')}</td>
          <td class="num neg">${escapeHtml(fmtCurrency(m.currentSpend, currency))}</td>
          <td class="num">${escapeHtml(fmtCurrency(m.previousSpend, currency))}</td>
          <td class="num"><span class="badge ${badgeCls}">${arrow} ${escapeHtml(fmtPct(delta, true))}</span></td>
        </tr>`;
    }).join('');

    momHtml = `
      <div style="margin-top:24px">
        <div class="section-title" style="font-size:14px">Month-over-Month</div>
        <div class="section-subtitle" style="margin-bottom:12px">Current vs. previous month spend</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Recipient</th>
              <th class="num">This Month</th>
              <th class="num">Last Month</th>
              <th class="num">Change</th>
            </tr>
          </thead>
          <tbody>${momRows}</tbody>
        </table>
      </div>`;
  }

  return `
    <div class="page page-break">
      <div class="section-title">Top Recipients</div>
      <div class="section-subtitle">Merchants ranked by total spend (all time)</div>
      <hr class="section-divider">
      ${chartHtml}
    </div>
    <div class="page-continuation">
      ${filterNoticeHtml}
      <table class="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Recipient</th>
            <th class="num">Total Spent</th>
            <th class="num">Txns</th>
            <th class="num">Avg/Txn</th>
            <th>Last Seen</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${topTableNote}
      ${momHtml}
    </div>`;
}
