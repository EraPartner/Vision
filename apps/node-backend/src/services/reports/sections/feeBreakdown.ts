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
} from "../sectionHelpers.ts";
import type { TaxReportData } from '../dataFetcherTax.ts';
import { divide, multiply, toDecimal, toNumber } from "../../../lib/money.ts";

export function renderFeeBreakdown(
  data: TaxReportData | null,
  { currency }: { currency: string },
): string {
  const byAssetClass = data?.byAssetClass ?? [];

  const rows = byAssetClass
    .map((b) => ({
      label: assetClassLabel(b.assetClass, { plural: true }),
      fees: b.fees,
      taxes: b.taxes,
    }))
    .filter((r) => r.fees > 0)
    .sort((a, b) => toDecimal(b.fees).comparedTo(a.fees));

  const totalFees = data?.feesTotal ?? 0;

  if (rows.length === 0 && totalFees === 0) {
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
      const share = totalFees > 0 ? toNumber(multiply(divide(r.fees, totalFees), 100)) : 0;
      return `<tr>
      <td>${escapeHtml(r.label)}</td>
      <td class="num neg">${fmtCurrency(r.fees, currency)}</td>
      <td class="num">${fmtPct(share, true)}</td>
    </tr>`;
    })
    .join("");

  const chartHtml = barItems.length > 0
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
