/**
 * Portfolio Executive Summary section renderer.
 *
 * Renders KPI grid: total value, invested, unrealised P/L, realised P/L,
 * dividends YTD, return %, inflation-adjusted value; plus top-holdings mini-table.
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
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string; period: object }} ctx
 * @returns {string}  HTML page div
 */
export function renderPortfolioExecutiveSummary(data, { currency }) {
  const summary = data?.executiveSummary;
  if (!summary) {
    return emptySection({
      title: "Portfolio Overview",
      subtitle: "Key performance indicators",
      heading: "No portfolio data",
      message: "Add investments to see the executive summary.",
    });
  }

  const glClass = signClass(summary.totalGainLoss);
  const retClass = signClass(summary.returnPct);

  const kpiCards = kpiGrid([
    { label: "Total Value", value: fmtCurrency(summary.totalValue, currency) },
    {
      label: "Total Invested",
      value: fmtCurrency(summary.totalInvested, currency),
    },
    {
      label: "Unrealised P/L",
      value: fmtCurrency(summary.totalGainLoss, currency),
      sub: fmtPct(summary.returnPct, true),
      cls: glClass,
      subCls: glClass,
    },
    {
      label: "Dividends",
      value: fmtCurrency(summary.totalDividends, currency),
      sub: "period total",
    },
  ]);

  const kpiCards2 = kpiGrid(
    [
      {
        label: "Return %",
        value: fmtPct(summary.returnPct, true),
        cls: retClass,
      },
      {
        label: "Inflation-Adj. Value",
        value: fmtCurrency(summary.inflationAdjustedValue, currency),
      },
      {
        label: "Holdings",
        value: String(summary.holdingsCount),
        sub: "active investments",
      },
    ],
    { cols: 3 },
  );

  const rows = summary.topHoldings
    .map((inv) => {
      const val = Number(inv.currentValue ?? 0);
      const gl = Number(inv.gainLoss ?? 0);
      const cls = signClass(gl);
      return `<tr>
      <td>${escapeHtml(inv.name ?? "—")}</td>
      <td>${escapeHtml(inv.symbol ?? "—")}</td>
      <td class="num">${fmtCurrency(val, currency)}</td>
      <td class="num ${cls}">${fmtCurrency(gl, currency)}</td>
    </tr>`;
    })
    .join("");

  return sectionPage({
    title: "Portfolio Overview",
    subtitle: "Key performance indicators for the selected period",
    content: `
      ${kpiCards}
      ${kpiCards2}
      ${
        summary.topHoldings.length
          ? `
        <table class="data-table">
          <thead><tr>
            <th>Investment</th><th>Symbol</th>
            <th class="num">Value (${escapeHtml(currency)})</th>
            <th class="num">Unrealised P/L</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`
          : ""
      }`,
  });
}
