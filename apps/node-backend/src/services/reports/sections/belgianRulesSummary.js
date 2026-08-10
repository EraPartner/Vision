/**
 * Belgian Rules Summary section renderer.
 *
 * Static bracket table for the tax year + PIT summary block when supplied.
 */

import { escapeHtml, fmtCurrency, fmtPct } from '../sectionHelpers.js';

/**
 * @param {import('../dataFetcherTax.js').TaxReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderBelgianRulesSummary(data, { currency }) {
  const taxTables      = data?.taxTables      ?? null;
  const precomputedPIT = data?.precomputedPIT ?? null;
  const taxYear        = data?.taxYear        ?? '—';
  const taxProfile     = data?.taxProfile     ?? null;

  if (!taxTables && !precomputedPIT) {
    return `
      <div class="page">
        <div class="section-title">Belgian Tax Rules</div>
        <div class="section-subtitle">Tax year ${taxYear} bracket reference</div>
        <hr class="section-divider">
        <div class="placeholder-notice"><strong>No tax table data</strong>Belgian tax bracket data unavailable for year ${taxYear}.</div>
      </div>`;
  }

  const tob = taxTables?.tob ?? {};

  const tobRows = Object.entries(tob).map(([key, t]) => {
    const label = {
      bonds:              'Bonds',
      sharesAndOther:     'Shares & Other',
      accumulatingFunds:  'Accumulating Funds',
      distributingFunds:  'Distributing Funds',
    }[key] ?? key;
    const cap = t.cap != null ? fmtCurrency(t.cap, 'EUR') : '—';
    return `<tr>
      <td>${escapeHtml(label)}</td>
      <td class="num">${t.rate != null ? fmtPct(t.rate, false, 2) : '—'}</td>
      <td class="num">${cap}</td>
    </tr>`;
  }).join('');

  const pitHtml = precomputedPIT ? renderPITBlock(precomputedPIT, taxProfile, currency) : '';

  return `
    <div class="page">
      <div class="section-title">Belgian Tax Rules — ${taxYear}</div>
      <div class="section-subtitle">Reference bracket data for tax year ${taxYear}</div>
      <hr class="section-divider">

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">
        <div>
          <div style="font-size:11px;font-weight:600;color:hsl(var(--muted));text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Dividend Tax</div>
          <table class="data-table">
            <tbody>
              <tr><td>Exemption (first-year allowance)</td><td class="num">${taxTables?.dividendExemption != null ? fmtCurrency(taxTables.dividendExemption, 'EUR') : '—'}</td></tr>
              <tr><td>Withholding Tax Rate</td><td class="num">${taxTables?.dividendWHTRate != null ? fmtPct(taxTables.dividendWHTRate, false) : '—'}</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;color:hsl(var(--muted));text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">TOB (Beurstaks)</div>
          <table class="data-table">
            <thead><tr><th>Instrument</th><th class="num">Rate</th><th class="num">Cap</th></tr></thead>
            <tbody>${tobRows}</tbody>
          </table>
        </div>
      </div>

      ${pitHtml}
    </div>`;
}

/**
 * @param {import('../dataFetcherTax.js').PrecomputedPIT} pit
 * @param {import('../dataFetcherTax.js').TaxProfile | null} profile
 * @param {string} currency
 * @returns {string}
 */
function renderPITBlock(pit, profile, currency) {
  if (!pit) return '';

  // Unlike taxTables rates (fractions), the client sends bracket rates already in
  // percent units (pit.ts: `rate: br.rate * 100`) — hence isRaw.
  const rows = (pit.brackets ?? []).map(b => `<tr>
    <td>${b.label ?? '—'}</td>
    <td class="num">${b.rate != null ? fmtPct(b.rate, true) : '—'}</td>
    <td class="num">${b.taxableIncome != null ? fmtCurrency(b.taxableIncome, currency) : '—'}</td>
    <td class="num neg">${b.taxAmount != null ? fmtCurrency(b.taxAmount, currency) : '—'}</td>
  </tr>`).join('');

  const profileLine = profile
    ? `<p style="color:hsl(var(--muted));font-size:11px;margin:0 0 8px;">Filing status: ${escapeHtml(profile.filingStatus ?? '—')} · Taxable income: ${pit.taxableIncome != null ? fmtCurrency(pit.taxableIncome, currency) : '—'}</p>`
    : '';

  return `
    <div style="margin-top:16px;">
      <div style="font-size:11px;font-weight:600;color:hsl(var(--muted));text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Personal Income Tax Estimate</div>
      ${profileLine}
      ${rows ? `<table class="data-table">
        <thead><tr><th>Bracket</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead>
        <tbody>${rows}</tbody>
        ${pit.totalTax != null ? `<tfoot><tr style="font-weight:600;"><td colspan="3">Estimated Total PIT</td><td class="num neg">${fmtCurrency(pit.totalTax, currency)}</td></tr></tfoot>` : ''}
      </table>` : '<p style="color:hsl(var(--muted));font-size:12px;">Bracket detail not provided.</p>'}
    </div>`;
}
