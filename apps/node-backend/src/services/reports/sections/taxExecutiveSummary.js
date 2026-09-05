/**
 * Tax Executive Summary section renderer.
 *
 * KPI grid: total taxes, fees, net taxable result, dividend WHT, TOB, capital gains, effective rate.
 */

import {
  emptySection,
  escapeHtml,
  fmtCurrency,
  fmtPct,
  kpiGrid,
  sectionPage,
  signClass,
} from "../sectionHelpers.js";

/**
 * @param {import('../dataFetcherTax.js').TaxReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderTaxExecutiveSummary(data, { currency }) {
  const taxYear = data?.taxYear ?? "—";
  const periodNote = data?.periodNote ?? null;
  const taxProfile = data?.taxProfile ?? null;

  const tobTotal = data?.tobTotal ?? 0;
  const dividendWHTTotal = data?.dividendWHTTotal ?? 0;
  const sellTaxTotal = data?.sellTaxTotal ?? 0;
  const feesTotal = data?.feesTotal ?? 0;
  const otherTaxTotal = data?.otherTaxTotal ?? 0;
  const dividendsReceived = data?.dividendsReceived ?? 0;
  const grossDividendBase = data?.grossDividendBase ?? null;
  const netDividendResult = data?.netDividendResult ?? null;
  const unknownDividendConventionCount =
    data?.unknownDividendConventionCount ?? 0;

  const totalTaxes = tobTotal + dividendWHTTotal + sellTaxTotal + otherTaxTotal;
  const totalCosts = totalTaxes + feesTotal;
  const effectiveRate =
    grossDividendBase !== null && grossDividendBase > 0
      ? (dividendWHTTotal / grossDividendBase) * 100
      : null;
  const netCls = netDividendResult === null ? "" : signClass(netDividendResult);

  const hasData = totalCosts > 0 || dividendsReceived > 0;

  if (!hasData) {
    return emptySection({
      title: "Tax Summary",
      subtitle: `Overview of taxes and fees for ${taxYear}`,
      heading: "No tax data",
      message: "No tax transactions found for the selected period.",
    });
  }

  const noteHtml = periodNote
    ? `<p style="color:hsl(var(--muted));font-size:11px;margin:0 0 12px;">${periodNote}</p>`
    : "";

  // Flag any foreign currency that had no FX rate available and was therefore
  // summed at an unconverted 1:1 rate, so the totals above are not mistaken for
  // exact figures (ADR-085).
  const unconverted = Array.isArray(data?.unconvertedCurrencies)
    ? data.unconvertedCurrencies
    : [];
  const fxWarningHtml =
    unconverted.length > 0
      ? `<p style="color:hsl(var(--warning, 38 92% 50%));font-size:11px;margin:0 0 12px;"><strong>Approximate:</strong> no exchange rate was available for ${unconverted.join(", ")}; ${unconverted.length > 1 ? "these amounts were" : "this amount was"} included at a 1:1 rate.</p>`
      : "";

  const profileHtml = taxProfile
    ? `<p style="color:hsl(var(--muted));font-size:11px;margin:0 0 12px;">Tax profile: ${escapeHtml(taxProfile.filingStatus ?? "")} · ${escapeHtml(taxProfile.region ?? "")}</p>`
    : "";

  const conventionWarningHtml =
    unknownDividendConventionCount > 0
      ? `<p style="color:hsl(var(--warning, 38 92% 50%));font-size:11px;margin:0 0 12px;"><strong>Incomplete dividend metrics:</strong> ${unknownDividendConventionCount} dividend ${unknownDividendConventionCount === 1 ? "row has" : "rows have"} an unknown gross/net amount convention. Recorded amounts and taxes remain shown, but the effective withholding rate and net dividend result are unavailable.</p>`
      : "";

  return sectionPage({
    title: "Tax Summary",
    subtitle: `Taxes and fees for tax year ${taxYear}`,
    content: `
      ${noteHtml}${profileHtml}${fxWarningHtml}${conventionWarningHtml}
      ${kpiGrid([
        {
          label: "Total Taxes Paid",
          value: fmtCurrency(totalTaxes, currency),
          cls: "neg",
        },
        {
          label: "Total Fees",
          value: fmtCurrency(feesTotal, currency),
          cls: "neg",
        },
        {
          label: "Total Cost",
          value: fmtCurrency(totalCosts, currency),
          cls: "neg",
        },
        {
          label: "Dividend Amounts Recorded",
          value: fmtCurrency(dividendsReceived, currency),
        },
      ])}
      ${kpiGrid(
        [
          {
            label: "TOB (Transaction Tax)",
            value: fmtCurrency(tobTotal, currency),
            valueStyle: "font-size:18px;",
          },
          {
            label: "Dividend WHT",
            value: fmtCurrency(dividendWHTTotal, currency),
            valueStyle: "font-size:18px;",
          },
          {
            label: "Capital Gains Tax",
            value: fmtCurrency(sellTaxTotal, currency),
            valueStyle: "font-size:18px;",
          },
          {
            label: "Effective WHT Rate",
            value:
              effectiveRate === null
                ? "Incomplete"
                : fmtPct(effectiveRate, true),
            valueStyle: "font-size:18px;",
          },
        ],
        { style: "margin-top: 8px;" },
      )}
      <table class="data-table" style="margin-top:16px;">
        <thead><tr>
          <th>Tax Component</th>
          <th class="num">Amount</th>
          <th class="num">% of Total Cost</th>
        </tr></thead>
        <tbody>
          <tr><td>TOB (Transaction Tax)</td><td class="num neg">${fmtCurrency(tobTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((tobTotal / totalCosts) * 100, true) : "—"}</td></tr>
          <tr><td>Dividend Withholding Tax</td><td class="num neg">${fmtCurrency(dividendWHTTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((dividendWHTTotal / totalCosts) * 100, true) : "—"}</td></tr>
          <tr><td>Capital Gains / Sell Tax</td><td class="num neg">${fmtCurrency(sellTaxTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((sellTaxTotal / totalCosts) * 100, true) : "—"}</td></tr>
          <tr><td>Other Taxes</td><td class="num neg">${fmtCurrency(otherTaxTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((otherTaxTotal / totalCosts) * 100, true) : "—"}</td></tr>
          <tr><td>Broker / Management Fees</td><td class="num neg">${fmtCurrency(feesTotal, currency)}</td><td class="num">${totalCosts > 0 ? fmtPct((feesTotal / totalCosts) * 100, true) : "—"}</td></tr>
          <tr style="font-weight:600;border-top:2px solid hsl(var(--border));">
            <td>Net Dividend Result</td>
            <td class="num ${netCls}">${netDividendResult === null ? "Incomplete" : fmtCurrency(netDividendResult, currency)}</td>
            <td class="num">—</td>
          </tr>
        </tbody>
      </table>`,
  });
}
