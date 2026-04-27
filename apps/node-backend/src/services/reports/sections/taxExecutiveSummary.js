/**
 * Tax Executive Summary section renderer.
 *
 * KPI grid: total taxes, fees, net taxable result, dividend WHT, TOB, capital gains, effective rate.
 */

import { fmtCurrency, fmtPct, signClass } from '../sectionHelpers.js';

/**
 * @param {object | null} data  fetchTaxData result
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTaxExecutiveSummary(data, { currency }) {
  const totals       = data?.totals       ?? {};
  const taxYear      = data?.taxYear      ?? '—';
  const periodNote   = data?.periodNote   ?? null;
  const taxProfile   = data?.taxProfile   ?? null;

  const tobTotal          = totals.tobTotal          ?? 0;
  const dividendWHTTotal  = totals.dividendWHTTotal  ?? 0;
  const sellTaxTotal      = totals.sellTaxTotal      ?? 0;
  const feesTotal         = totals.feesTotal         ?? 0;
  const otherTaxTotal     = totals.otherTaxTotal     ?? 0;
  const dividendsReceived = totals.dividendsReceived ?? 0;

  const totalTaxes  = tobTotal + dividendWHTTotal + sellTaxTotal + otherTaxTotal;
  const totalCosts  = totalTaxes + feesTotal;
  const effectiveRate = dividendsReceived > 0 ? (dividendWHTTotal / dividendsReceived) * 100 : 0;

  const netResult   = dividendsReceived - dividendWHTTotal;
  const netCls      = signClass(netResult);

  const hasData = totalCosts > 0 || dividendsReceived > 0;

  if (!hasData) {
    return `
      <div class="page">
        <div class="section-title">Tax Summary</div>
        <div class="section-subtitle">Overview of taxes and fees for ${taxYear}</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No tax data</strong>No tax transactions found for the selected period.</div>
      </div>`;
  }

  const noteHtml = periodNote
    ? `<p style="color:hsl(var(--muted));font-size:11px;margin:0 0 12px;">${periodNote}</p>`
    : '';

  const profileHtml = taxProfile
    ? `<p style="color:hsl(var(--muted));font-size:11px;margin:0 0 12px;">Tax profile: ${taxProfile.filingStatus ?? ''} · ${taxProfile.region ?? ''}</p>`
    : '';

  return `
    <div class="page">
      <div class="section-title">Tax Summary</div>
      <div class="section-subtitle">Taxes and fees for tax year ${taxYear}</div>
      <hr class="section-divider">
      ${noteHtml}${profileHtml}
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Taxes Paid</div>
          <div class="kpi-value neg">${fmtCurrency(totalTaxes, currency)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Fees</div>
          <div class="kpi-value neg">${fmtCurrency(feesTotal, currency)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Cost</div>
          <div class="kpi-value neg">${fmtCurrency(totalCosts, currency)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Dividends Received</div>
          <div class="kpi-value">${fmtCurrency(dividendsReceived, currency)}</div>
        </div>
      </div>
      <div class="kpi-grid" style="grid-template-columns: repeat(4, 1fr); margin-top: 8px;">
        <div class="kpi-card">
          <div class="kpi-label">TOB (Transaction Tax)</div>
          <div class="kpi-value" style="font-size:18px;">${fmtCurrency(tobTotal, currency)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Dividend WHT</div>
          <div class="kpi-value" style="font-size:18px;">${fmtCurrency(dividendWHTTotal, currency)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Capital Gains Tax</div>
          <div class="kpi-value" style="font-size:18px;">${fmtCurrency(sellTaxTotal, currency)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Effective WHT Rate</div>
          <div class="kpi-value" style="font-size:18px;">${fmtPct(effectiveRate, false)}</div>
        </div>
      </div>
      <table class="data-table" style="margin-top:16px;">
        <thead><tr>
          <th>Tax Component</th>
          <th class="num">Amount</th>
          <th class="num">% of Total Cost</th>
        </tr></thead>
        <tbody>
          <tr><td>TOB (Transaction Tax)</td><td class="num neg">${fmtCurrency(tobTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((tobTotal / totalCosts) * 100, false) : '—'}</td></tr>
          <tr><td>Dividend Withholding Tax</td><td class="num neg">${fmtCurrency(dividendWHTTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((dividendWHTTotal / totalCosts) * 100, false) : '—'}</td></tr>
          <tr><td>Capital Gains / Sell Tax</td><td class="num neg">${fmtCurrency(sellTaxTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((sellTaxTotal / totalCosts) * 100, false) : '—'}</td></tr>
          <tr><td>Other Taxes</td><td class="num neg">${fmtCurrency(otherTaxTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((otherTaxTotal / totalCosts) * 100, false) : '—'}</td></tr>
          <tr><td>Broker / Management Fees</td><td class="num neg">${fmtCurrency(feesTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((feesTotal / totalCosts) * 100, false) : '—'}</td></tr>
          <tr style="font-weight:600;border-top:2px solid hsl(var(--border));">
            <td>Net Dividend Result</td>
            <td class="num ${netCls}">${fmtCurrency(netResult, currency)}</td>
            <td class="num">—</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}
