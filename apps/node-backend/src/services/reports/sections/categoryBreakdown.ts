/**
 * Section renderer: Category Breakdown.
 *
 * Selected-period category totals, with server-aggregated exclusion comparisons.
 */

import {
  comparisonChartPair,
  emptySection,
  escapeHtml,
  filterNotice,
  fmtCurrency,
  sectionPage,
  svgHorizontalBars,
} from "../sectionHelpers.ts";
import type { FinancialReportData, Period } from "../dataFetcher.ts";

const MAX_CHART_ITEMS = 10;
const MAX_TABLE_ROWS = 20;

export function renderCategoryBreakdown(
  data: Partial<
    Pick<FinancialReportData, "categories" | "filteredCategories" | "exclusions">
  >,
  { currency }: { currency: string; period: Period },
): string {
  const cats = data.categories?.categories ?? [];
  const excludedCategoryIds = data.exclusions?.categoryIds ?? [];
  const hasExclusions =
    excludedCategoryIds.length > 0 ||
    (data.exclusions?.recipientIds.length ?? 0) > 0;

  if (cats.length === 0) {
    return emptySection({
      title: "Category Breakdown",
      subtitle: "Spending by category",
      message: "No category data available.",
      pageBreak: true,
    });
  }

  // Sort by absolute total (largest spend first)
  const sorted = [...cats].sort(
    (a, b) => Math.abs(b.total) - Math.abs(a.total),
  );

  // Both sets have already been aggregated with the same date boundaries.
  const filteredSorted = hasExclusions
    ? [...(data.filteredCategories?.categories ?? [])].sort(
        (a, b) => Math.abs(b.total) - Math.abs(a.total),
      )
    : null;

  // Build chart section — single chart normally, dual comparison when filters active
  let chartHtml;
  if (hasExclusions && filteredSorted) {
    const allItems = sorted.slice(0, MAX_CHART_ITEMS).map((c) => ({
      label: c.name,
      value: Math.abs(c.total),
      fmtValue: fmtCurrency(Math.abs(c.total), currency),
    }));
    const filteredItems = filteredSorted.slice(0, MAX_CHART_ITEMS).map((c) => ({
      label: c.name,
      value: Math.abs(c.total),
      fmtValue: fmtCurrency(Math.abs(c.total), currency),
    }));
    chartHtml = comparisonChartPair({
      filteredLabel: `With active filters (${filteredSorted.length} categor${filteredSorted.length === 1 ? "y" : "ies"})`,
      filteredChart: svgHorizontalBars(filteredItems),
      allLabel: `All data (${sorted.length} categor${sorted.length === 1 ? "y" : "ies"})`,
      allChart: svgHorizontalBars(allItems),
    });
  } else {
    const chartItems = sorted.slice(0, MAX_CHART_ITEMS).map((c) => ({
      label: c.name,
      value: Math.abs(c.total),
      fmtValue: fmtCurrency(Math.abs(c.total), currency),
    }));
    chartHtml = `<div class="chart-wrap">${svgHorizontalBars(chartItems)}</div>`;
  }

  // Table: filtered rows when exclusions active, full set otherwise
  const tableSource = filteredSorted ?? sorted;
  const tableRows = tableSource
    .slice(0, MAX_TABLE_ROWS)
    .map((c, i) => {
      const rank = i + 1;
      const total = Math.abs(c.total);
      // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
      const avg = c.count > 0 ? total / c.count : 0;
      return `
      <tr>
        <td style="color:hsl(var(--muted));font-size:10px">${rank}</td>
        <td>${escapeHtml(c.name)}</td>
        <td class="num neg">${escapeHtml(fmtCurrency(total, currency))}</td>
        <td class="num">${c.count}</td>
        <td class="num">${escapeHtml(fmtCurrency(avg, currency))}</td>
      </tr>`;
    })
    .join("");

  const note =
    tableSource.length > MAX_TABLE_ROWS
      ? `<p style="font-size:10px;color:hsl(var(--muted));margin-top:8px">Showing top ${MAX_TABLE_ROWS} of ${tableSource.length} categories by spend.</p>`
      : "";

  const filterNoticeHtml = hasExclusions
    ? filterNotice({
        filteredCount: filteredSorted?.length ?? 0,
        excludedCount: excludedCategoryIds.length,
        singular: "category",
        plural: "categories",
      })
    : "";

  return `${sectionPage({ title: "Category Breakdown", subtitle: "Top spending categories for the selected period", content: chartHtml, pageBreak: true })}
    <div class="page-continuation">
      ${filterNoticeHtml}
      <table class="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Category</th>
            <th class="num">Total Spent</th>
            <th class="num">Txns</th>
            <th class="num">Avg/Txn</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${note}
    </div>`;
}
