/**
 * Fee Breakdown section renderer.
 *
 * Fees per asset class; horizontal bars + table.
 */

import {
  emptySection,
  assetClassLabel,
  escapeHtml,
  fmtCurrency,
  fmtPct,
  sectionPage,
  svgHorizontalBars,
} from "../sectionHelpers.js";

/**
 * @param {import('../dataFetcherTax.js').TaxReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderFeeBreakdown(data, { currency }) {
  const byAssetClass = data?.byAssetClass ?? [];

  const rows = byAssetClass
    .map((b) => ({
      label: assetClassLabel(b.assetClass ?? "other", { plural: true }),
      fees: b.fees ?? 0,
      taxes: b.taxes ?? 0,
    }))
    .filter((r) => r.fees > 0)
    .sort((a, b) => b.fees - a.fees);

  const totalFees = data?.feesTotal ?? 0;

  if (!rows.length && totalFees === 0) {
    return emptySection({
      title: "Fee Breakdown",
      subtitle: "Broker and management fees by asset class",
      heading: "No fee data",
      message: "No fees found for the selected period.",
    });
  }

  const barItems = rows.map((r) => ({
    label: r.label,
    value: r.fees,
    fmtValue: fmtCurrency(r.fees, currency),
  }));

  const tableRows = rows
    .map((r) => {
      const share = totalFees > 0 ? (r.fees / totalFees) * 100 : 0;
      return `<tr>
      <td>${escapeHtml(r.label)}</td>
      <td class="num neg">${fmtCurrency(r.fees, currency)}</td>
      <td class="num">${fmtPct(share, true)}</td>
    </tr>`;
    })
    .join("");

  const chartHtml = barItems.length
    ? `<div class="chart-wrap">${svgHorizontalBars(barItems, { maxItems: 8 })}</div>`
    : "";

  return sectionPage({
    title: "Fee Breakdown",
    subtitle: `Total fees: ${fmtCurrency(totalFees, currency)}`,
    content: `
      ${chartHtml}
      ${
        tableRows
          ? `
        <table class="data-table">
          <thead><tr>
            <th>Asset Class</th>
            <th class="num">Fees Paid</th>
            <th class="num">Share</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>`
          : `<p style="color:hsl(var(--muted));font-size:12px;">Fee detail by asset class unavailable — total: ${fmtCurrency(totalFees, currency)}</p>`
      }`,
  });
}
