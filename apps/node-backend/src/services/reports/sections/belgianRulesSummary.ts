/**
 * Belgian Rules Summary section renderer.
 *
 * Static bracket table for the tax year + PIT summary block when supplied.
 */

import { emptySection, escapeHtml, fmtCurrency, fmtPct, sectionPage } from '../sectionHelpers.ts';
import { addAll, toNumber } from '../../../lib/money.ts';
import type {
  PrecomputedHousehold,
  PrecomputedPIT,
  ReportHousehold,
  TaxProfile,
  TaxReportData,
} from '../dataFetcherTax.ts';
import type { TobBracket } from '../belgianTaxTables.ts';

export function renderBelgianRulesSummary(
  data: TaxReportData | null,
  { currency }: { currency: string },
): string {
  const taxTables      = data?.taxTables      ?? null;
  const precomputedPIT = data?.precomputedPIT ?? null;
  const taxYear        = data?.taxYear        ?? '—';
  const taxProfile     = data?.taxProfile     ?? null;

  if (!taxTables && !precomputedPIT) {
    return emptySection({ title: 'Belgian Tax Rules', subtitle: `Tax year ${taxYear} bracket reference`, heading: 'No tax table data', message: `Belgian tax bracket data unavailable for year ${taxYear}.` });
  }

  const tob: Record<string, TobBracket> = taxTables?.tob ?? {};

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
  const householdHtml = renderHouseholdBlock(
    data?.precomputedHousehold,
    data?.household,
    currency,
  );

  return sectionPage({
    title: `Belgian Tax Rules — ${taxYear}`,
    subtitle: `Reference bracket data for tax year ${taxYear}`,
    content: `
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
      ${pitHtml}${householdHtml}`,
  });
}

const PARTNER_LABELS: Record<'A' | 'B', string> = { A: 'You', B: 'Partner' };
const ASSESSMENT_LABELS: Record<PrecomputedHousehold['assessmentMode'], string> = {
  single: 'Single',
  separate: 'Separate',
  joint: 'Joint',
};

/** "You" / "Partner", with the partner's display name when the household has one. */
function partnerName(id: 'A' | 'B', household: ReportHousehold | undefined): string {
  const name = household?.partners.find((p) => p.id === id)?.displayName?.trim();
  return name ? `${PARTNER_LABELS[id]} (${name})` : PARTNER_LABELS[id];
}

/**
 * Per-partner rows (ADR-200/201) plus the household total, the assessment mode and, under a
 * joint assessment, the marital quotient line. Renders nothing unless two partners are
 * assessed, so a one-partner household keeps exactly the rows it had before.
 */
export function renderHouseholdBlock(
  result: PrecomputedHousehold | undefined,
  household: ReportHousehold | undefined,
  currency: string,
): string {
  if (!result || result.partners.length < 2) return '';
  const total = (pick: (p: PrecomputedHousehold['partners'][number]) => number) =>
    toNumber(addAll(result.partners.map(pick)));
  const rows = result.partners.map((p) => `<tr>
      <td>${escapeHtml(partnerName(p.partnerId, household))}</td>
      <td class="num">${fmtCurrency(p.grossIncome, currency)}</td>
      <td class="num">${fmtCurrency(p.taxableIncome, currency)}</td>
      <td class="num neg">${fmtCurrency(p.totalPIT, currency)}</td>
    </tr>`).join('');
  const basis = result.legalBasis ? ` (${escapeHtml(result.legalBasis)})` : '';
  const quotient = result.quotient;
  const quotientLine =
    result.assessmentMode !== 'joint'
      ? ''
      : quotient?.applied && quotient.fromPartnerId && quotient.toPartnerId
        ? `<p style="color:hsl(var(--muted));font-size:11px;margin:4px 0 0;">Marital quotient: ${fmtCurrency(quotient.transfer, currency)} from ${escapeHtml(partnerName(quotient.fromPartnerId, household))} to ${escapeHtml(partnerName(quotient.toPartnerId, household))} · saving ${fmtCurrency(quotient.benefit, currency)}</p>`
        : '<p style="color:hsl(var(--muted));font-size:11px;margin:4px 0 0;">Marital quotient: not applied</p>';
  return `
    <div style="margin-top:16px;">
      <div style="font-size:11px;font-weight:600;color:hsl(var(--muted));text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Per Partner</div>
      <p style="color:hsl(var(--muted));font-size:11px;margin:0 0 8px;">Assessment: ${ASSESSMENT_LABELS[result.assessmentMode]}${basis}</p>
      <table class="data-table">
        <thead><tr><th>Partner</th><th class="num">Gross income</th><th class="num">Taxable</th><th class="num">Tax</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="font-weight:600;"><td>Household</td><td class="num">${fmtCurrency(total((p) => p.grossIncome), currency)}</td><td class="num">${fmtCurrency(total((p) => p.taxableIncome), currency)}</td><td class="num neg">${fmtCurrency(total((p) => p.totalPIT), currency)}</td></tr></tfoot>
      </table>
      ${quotientLine}
    </div>`;
}

function renderPITBlock(
  pit: PrecomputedPIT,
  profile: TaxProfile | null,
  currency: string,
): string {
  if (!pit) return '';

  // Unlike taxTables rates (fractions), the client sends bracket rates already in
  // percent units (pit.ts: `rate: br.rate * 100`) — hence isRaw.
  const rows = (pit.brackets ?? []).map(b => `<tr>
    <td>${b.label != null ? escapeHtml(b.label) : '—'}</td>
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
