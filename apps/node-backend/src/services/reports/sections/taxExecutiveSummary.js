/**
 * Tax Executive Summary section renderer.
 *
 * KPI grid: total taxes, fees, net taxable result, dividend WHT, TOB, capital gains, effective rate.
 */

import { fmtCurrency, fmtPct, kpiGrid, signClass } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherTax.js').TaxReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTaxExecutiveSummary(data, { currency }) {
  const totals       = data?.totals       ?? /** @type {import('../dataFetcherTax.js').LegacyTaxTotalsFallback} */ ({});
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

  // Flag any foreign currency that had no FX rate available and was therefore
  // summed at an unconverted 1:1 rate, so the totals above are not mistaken for
  // exact figures (ADR-085).
  const unconverted = Array.isArray(data?.unconvertedCurrencies) ? data.unconvertedCurrencies : [];
  const fxWarningHtml = unconverted.length > 0
    ? `<p style="color:hsl(var(--warning, 38 92% 50%));font-size:11px;margin:0 0 12px;"><strong>Approximate:</strong> no exchange rate was available for ${unconverted.join(', ')}; ${unconverted.length > 1 ? 'these amounts were' : 'this amount was'} included at a 1:1 rate.</p>`
    : '';

  const profileHtml = taxProfile
    ? `<p style="color:hsl(var(--muted));font-size:11px;margin:0 0 12px;">Tax profile: ${taxProfile.filingStatus ?? ''} · ${taxProfile.region ?? ''}</p>`
    : '';

  return `
    <div class="page">
      <div class="section-title">Tax Summary</div>
      <div class="section-subtitle">Taxes and fees for tax year ${taxYear}</div>
      <hr class="section-divider">
      ${noteHtml}${profileHtml}${fxWarningHtml}
      ${kpiGrid([
        { label: 'Total Taxes Paid', value: fmtCurrency(totalTaxes, currency), cls: 'neg' },
        { label: 'Total Fees', value: fmtCurrency(feesTotal, currency), cls: 'neg' },
        { label: 'Total Cost', value: fmtCurrency(totalCosts, currency), cls: 'neg' },
        { label: 'Dividends Received', value: fmtCurrency(dividendsReceived, currency) },
      ])}
      ${kpiGrid([
        { label: 'TOB (Transaction Tax)', value: fmtCurrency(tobTotal, currency), valueStyle: 'font-size:18px;' },
        { label: 'Dividend WHT', value: fmtCurrency(dividendWHTTotal, currency), valueStyle: 'font-size:18px;' },
        { label: 'Capital Gains Tax', value: fmtCurrency(sellTaxTotal, currency), valueStyle: 'font-size:18px;' },
        { label: 'Effective WHT Rate', value: fmtPct(effectiveRate, false), valueStyle: 'font-size:18px;' },
      ], { style: 'margin-top: 8px;' })}
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
