/**
 * Performance Trend section renderer.
 *
 * Overlays portfolio value, invested capital, and inflation-adjusted value
 * on a line chart, with a monthly return-% mini-table below.
 */

import {
  emptySection,
  fmtCurrency,
  fmtMonthLabel,
  fmtPct,
  sectionPage,
  signClass,
  svgLineChart,
} from "../sectionHelpers.js";

/**
 * @param {import('../dataFetcherPortfolio.js').PortfolioReportData | null} data
 * @param {{ currency: string }} ctx
 * @returns {string}
 */
export function renderPerformanceTrend(data, { currency }) {
  const trend = data?.performanceTrend;

  if (!trend?.points.length) {
    return emptySection({
      title: "Performance Trend",
      subtitle: "Portfolio value vs. invested capital over time",
      heading: "No snapshot data",
      message:
        "Performance snapshots are generated nightly. Check back tomorrow.",
    });
  }

  const labels = trend.points.map((point) =>
    fmtMonthLabel(point.year, point.month),
  );

  const series = [
    {
      label: "Portfolio Value",
      color: "hsl(var(--chart-1))",
      values: trend.points.map((point) => point.value),
    },
    {
      label: "Invested Capital",
      color: "hsl(var(--chart-2))",
      values: trend.points.map((point) => point.invested),
    },
    {
      label: "Inflation-Adj. Value",
      color: "hsl(var(--chart-4))",
      values: trend.points.map((point) => point.inflationAdjustedValue),
    },
  ];

  const chart = svgLineChart(series, { labels, height: 180 });

  const tableRows = trend.tablePoints
    .map((point) => {
      const cls = signClass(point.gainLoss);
      return `<tr>
      <td>${fmtMonthLabel(point.year, point.month)}</td>
      <td class="num">${fmtCurrency(point.invested, currency)}</td>
      <td class="num">${fmtCurrency(point.value, currency)}</td>
      <td class="num ${cls}">${fmtCurrency(point.gainLoss, currency)}</td>
      <td class="num ${cls}">${fmtPct(point.returnPct, true)}</td>
    </tr>`;
    })
    .join("");

  return sectionPage({
    title: "Performance Trend",
    subtitle: `Portfolio value vs. invested capital (${trend.points.length} data points)`,
    content: `
      <div class="chart-wrap">${chart}</div>
      ${
        tableRows
          ? `
        <table class="data-table">
          <thead><tr>
            <th>Month</th>
            <th class="num">Invested</th>
            <th class="num">Value</th>
            <th class="num">P/L</th>
            <th class="num">Return %</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>`
          : ""
      }`,
  });
}
