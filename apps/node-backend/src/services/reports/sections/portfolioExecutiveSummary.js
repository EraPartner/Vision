/**
 * Portfolio Executive Summary section renderer.
 *
 * Renders KPI grid: total value, invested, unrealised P/L, realised P/L,
 * dividends YTD, return %, inflation-adjusted value; plus top-holdings mini-table.
 */

import { escapeHtml, fmtCurrency, fmtPct, kpiGrid, signClass } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string; period: object }} ctx
 * @returns {string}  HTML page div
 */
export function renderPortfolioExecutiveSummary(data, { currency }) {
  if (!data?.breakdown?.length && !data?.snapshots?.length) {
    return `
      <div class="page">
        <div class="section-title">Portfolio Overview</div>
        <div class="section-subtitle">Key performance indicators</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No portfolio data</strong>Add investments to see the executive summary.</div>
      </div>`;
  }

  // Derive totals from breakdown (per-investment summaries)
  const breakdown = data.breakdown ?? [];
  let totalValue    = 0;
  let totalInvested = 0;
  let totalGainLoss = 0;

  for (const inv of breakdown) {
    totalValue    += Number(inv.currentValue    ?? inv.current_value    ?? 0);
    totalInvested += Number(inv.totalInvested   ?? inv.total_invested   ?? 0);
    totalGainLoss += Number(inv.gainLoss        ?? inv.gain_loss        ?? 0);
  }

  // Use latest snapshot for return % and inflation-adjusted value
  const snapshots = data.snapshots ?? [];
  const latest = snapshots.length ? snapshots[snapshots.length - 1] : null;
  const returnPct = latest ? Number(latest.return_pct ?? 0) : (totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0);
  const inflAdj   = latest ? Number(latest.inflation_adjusted_value ?? totalValue) : totalValue;

  // Dividends from dividends data
  const dividendsByMonth = data.dividends?.byMonth ?? [];
  const totalDividends   = dividendsByMonth.reduce((s, m) => s + m.amount, 0);

  const glClass  = signClass(totalGainLoss);
  const retClass = signClass(returnPct);

  const kpiCards = kpiGrid([
    { label: 'Total Value',    value: fmtCurrency(totalValue,    currency) },
    { label: 'Total Invested', value: fmtCurrency(totalInvested, currency) },
    { label: 'Unrealised P/L', value: fmtCurrency(totalGainLoss, currency), sub: fmtPct(returnPct, true), cls: glClass, subCls: glClass },
    { label: 'Dividends',      value: fmtCurrency(totalDividends, currency), sub: 'period total' },
  ]);

  const kpiCards2 = kpiGrid([
    { label: 'Return %',              value: fmtPct(returnPct, true), cls: retClass },
    { label: 'Inflation-Adj. Value',  value: fmtCurrency(inflAdj, currency) },
    { label: 'Holdings',              value: String(breakdown.length), sub: 'active investments' },
  ], { cols: 3 });

  // Top 5 holdings mini-table
  const top5 = [...breakdown]
    .sort((a, b) => (Number(b.currentValue ?? b.current_value ?? 0)) - (Number(a.currentValue ?? a.current_value ?? 0)))
    .slice(0, 5);

  const rows = top5.map(inv => {
    const val = Number(inv.currentValue ?? inv.current_value ?? 0);
    const gl  = Number(inv.gainLoss ?? inv.gain_loss ?? 0);
    const cls = signClass(gl);
    return `<tr>
      <td>${escapeHtml(inv.name ?? '—')}</td>
      <td>${escapeHtml(inv.symbol ?? '—')}</td>
      <td class="num">${fmtCurrency(val, currency)}</td>
      <td class="num ${cls}">${fmtCurrency(gl, currency)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="page">
      <div class="section-title">Portfolio Overview</div>
      <div class="section-subtitle">Key performance indicators for the selected period</div>
      <hr class="section-divider">
      ${kpiCards}
      ${kpiCards2}
      ${top5.length ? `
        <table class="data-table">
          <thead><tr>
            <th>Investment</th><th>Symbol</th>
            <th class="num">Value (${escapeHtml(currency)})</th>
            <th class="num">Unrealised P/L</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>` : ''}
    </div>`;
}
