import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assetClassLabel,
  buildAssetClassBuckets,
  comparisonChartPair,
  emptySection,
  filterNotice,
  sectionPage,
} from "../src/services/reports/sectionHelpers.js";
import {
  __buildPerformanceTrendData as buildPerformanceTrendData,
  __buildPortfolioExecutiveSummaryData as buildPortfolioExecutiveSummaryData,
  __normalizeBreakdownRow as normalizeBreakdownRow,
} from "../src/services/reports/dataFetcherPortfolio.js";
import { renderAssetClassDetail } from "../src/services/reports/sections/assetClassDetail.js";
import { renderBankBalances } from "../src/services/reports/sections/bankBalances.js";
import { renderBelgianRulesSummary } from "../src/services/reports/sections/belgianRulesSummary.js";
import { renderCashflowTrend } from "../src/services/reports/sections/cashflowTrend.js";
import { renderCategoryBreakdown } from "../src/services/reports/sections/categoryBreakdown.js";
import { renderDividendIncome } from "../src/services/reports/sections/dividendIncome.js";
import { renderExecutiveSummary } from "../src/services/reports/sections/executiveSummary.js";
import { renderFeeBreakdown } from "../src/services/reports/sections/feeBreakdown.js";
import { renderPerformanceTrend } from "../src/services/reports/sections/performanceTrend.js";
import { renderPlannedOutlook } from "../src/services/reports/sections/plannedOutlook.js";
import { renderPortfolioAllocation } from "../src/services/reports/sections/portfolioAllocation.js";
import { renderPortfolioExecutiveSummary } from "../src/services/reports/sections/portfolioExecutiveSummary.js";
import { renderRollingAverages } from "../src/services/reports/sections/rollingAverages.js";
import { renderTaxByAssetClass } from "../src/services/reports/sections/taxByAssetClass.js";
import { renderTaxExecutiveSummary } from "../src/services/reports/sections/taxExecutiveSummary.js";
import { renderTaxMonthlyTrend } from "../src/services/reports/sections/taxMonthlyTrend.js";
import { renderTaxTypeBreakdown } from "../src/services/reports/sections/taxTypeBreakdown.js";
import { renderTopHoldings } from "../src/services/reports/sections/topHoldings.js";
import { renderTopInvestmentsByCost } from "../src/services/reports/sections/topInvestmentsByCost.js";
import { renderTopRecipients } from "../src/services/reports/sections/topRecipients.js";

const currency = "EUR";
const period = { kind: "year", year: 2026 };

const EMPTY_RENDERERS = [
  () =>
    renderExecutiveSummary({ monthly: { months: [] } }, { currency, period }),
  () => renderCashflowTrend({ monthly: { months: [] } }, { currency, period }),
  () => renderCategoryBreakdown({}, { currency, period }),
  () => renderTopRecipients({}, { currency }),
  () => renderBankBalances({}, { currency }),
  () => renderRollingAverages({}, { currency }),
  () => renderPlannedOutlook({}, { currency }),
  () => renderPortfolioExecutiveSummary(null, { currency, period }),
  () => renderPortfolioAllocation(null, { currency }),
  () => renderTopHoldings(null, { currency }),
  () => renderPerformanceTrend(null, { currency }),
  () => renderAssetClassDetail(null, { currency }),
  () => renderDividendIncome(null, { currency }),
  () => renderTaxExecutiveSummary(null, { currency }),
  () => renderTaxTypeBreakdown(null, { currency }),
  () => renderTaxByAssetClass(null, { currency }),
  () => renderTaxMonthlyTrend(null, { currency }),
  () => renderTopInvestmentsByCost(null, { currency }),
  () => renderFeeBreakdown(null, { currency }),
  () => renderBelgianRulesSummary(null, { currency }),
];
const EMPTY_RENDERER_NAMES = [
  "executiveSummary",
  "cashflowTrend",
  "categoryBreakdown",
  "topRecipients",
  "bankBalances",
  "rollingAverages",
  "plannedOutlook",
  "portfolioExecutiveSummary",
  "portfolioAllocation",
  "topHoldings",
  "performanceTrend",
  "assetClassDetail",
  "dividendIncome",
  "taxExecutiveSummary",
  "taxTypeBreakdown",
  "taxByAssetClass",
  "taxMonthlyTrend",
  "topInvestmentsByCost",
  "feeBreakdown",
  "belgianRulesSummary",
];
const EMPTY_PAGE_BREAKS = new Set([
  "cashflowTrend",
  "categoryBreakdown",
  "topRecipients",
  "bankBalances",
  "rollingAverages",
  "plannedOutlook",
]);

const month = {
  year: 2026,
  month: 1,
  total_income: 100,
  total_spending: -40,
  net_amount: 60,
  transaction_count: 2,
};
const breakdown = [
  {
    id: 1,
    name: "Index Fund",
    symbol: "IDX",
    assetClass: "etf",
    currency,
    currentValue: 120,
    totalInvested: 100,
    gainLoss: 20,
    gainLossPercent: 20,
  },
];
const snapshot = {
  snapshot_date: "2026-01-31",
  value: 120,
  invested: 100,
  return_pct: 20,
  inflation_adjusted_value: 118,
};
const performanceTrend = buildPerformanceTrendData([snapshot]);
const executiveSummary = buildPortfolioExecutiveSummaryData(
  breakdown,
  [],
  null,
);
const taxData = {
  taxYear: 2026,
  tobTotal: 3,
  dividendWHTTotal: 2,
  sellTaxTotal: 1,
  otherTaxTotal: 0.5,
  feesTotal: 4,
  dividendsReceived: 10,
  byMonth: [
    { year: 2026, month: 1, tob: 3, wht: 2, sell: 1, other: 0.5, fees: 4 },
  ],
  byAssetClass: [{ assetClass: "etf", taxes: 6.5, fees: 4 }],
  byInvestment: [
    {
      investmentId: 1,
      name: "Index Fund",
      symbol: "IDX",
      tob: 3,
      wht: 2,
      sell: 1,
      other: 0.5,
      fees: 4,
      total: 10.5,
    },
  ],
  taxTables: { tob: {}, dividendExemption: 859, dividendWHTRate: 0.3 },
};

const POPULATED_RENDERERS = [
  {
    name: "executiveSummary",
    render: () =>
      renderExecutiveSummary(
        { monthly: { months: [month] } },
        { currency, period },
      ),
    pageBreak: false,
  },
  {
    name: "cashflowTrend",
    render: () =>
      renderCashflowTrend(
        { monthly: { months: [month] } },
        { currency, period },
      ),
    pageBreak: true,
  },
  {
    name: "categoryBreakdown",
    render: () =>
      renderCategoryBreakdown(
        {
          categories: {
            categories: [{ id: 1, name: "Food", total: -40, count: 2 }],
          },
          exclusions: { categoryIds: [] },
        },
        { currency, period },
      ),
    pageBreak: true,
    continuation: true,
  },
  {
    name: "topRecipients",
    render: () =>
      renderTopRecipients(
        {
          recipients: {
            topMerchants: [
              {
                recipientId: 1,
                name: "Shop",
                totalSpend: 40,
                transactionCount: 2,
                avgAmount: 20,
                lastSeen: "2026-01-31",
              },
            ],
            monthOverMonth: [],
          },
          exclusions: { recipientIds: [] },
        },
        { currency },
      ),
    pageBreak: true,
    continuation: true,
  },
  {
    name: "bankBalances",
    render: () =>
      renderBankBalances(
        {
          banks: {
            accounts: [
              {
                bank_account: "Checking",
                balance: 60,
                transaction_count: 2,
                last_transaction: "2026-01-31",
              },
            ],
            total_net_position: 60,
          },
        },
        { currency },
      ),
    pageBreak: true,
  },
  {
    name: "rollingAverages",
    render: () =>
      renderRollingAverages(
        {
          averages: {
            past_6_months: {
              avg_daily_spending: 2,
              avg_monthly_spending: 40,
              months_counted: 6,
            },
            current_month: {
              total_spending: 20,
              days_elapsed: 15,
              days_in_month: 31,
            },
            comparison: {
              pace: 1,
              variance: 0,
              projected_monthly_total: 40,
              avg_monthly_spending: 40,
            },
          },
        },
        { currency },
      ),
    pageBreak: true,
  },
  {
    name: "plannedOutlook",
    render: () =>
      renderPlannedOutlook(
        {
          planned: {
            summary: {
              total_income: 100,
              total_expenses: -40,
              net_amount: 60,
              transaction_count: 1,
            },
            daily_data: [
              {
                date: "2026-02-01",
                transactions: [
                  {
                    recipient_name: "Landlord",
                    category_name: "Housing:Rent",
                    amount: -40,
                    is_recurring: true,
                  },
                ],
              },
            ],
            period_start: "2026-02-01",
            period_end: "2026-02-28",
          },
        },
        { currency },
      ),
    pageBreak: true,
  },
  {
    name: "portfolioExecutiveSummary",
    render: () =>
      renderPortfolioExecutiveSummary(
        { executiveSummary },
        { currency, period },
      ),
    pageBreak: false,
  },
  {
    name: "portfolioAllocation",
    render: () =>
      renderPortfolioAllocation({ breakdown, snapshots: [] }, { currency }),
    pageBreak: false,
  },
  {
    name: "topHoldings",
    render: () => renderTopHoldings({ breakdown }, { currency }),
    pageBreak: false,
  },
  {
    name: "performanceTrend",
    render: () => renderPerformanceTrend({ performanceTrend }, { currency }),
    pageBreak: false,
  },
  {
    name: "assetClassDetail",
    render: () =>
      renderAssetClassDetail({ breakdown, snapshots: [] }, { currency }),
    pageBreak: false,
  },
  {
    name: "dividendIncome",
    render: () =>
      renderDividendIncome(
        {
          dividends: {
            byMonth: [{ year: 2026, month: 1, amount: 10 }],
            byInvestment: [
              {
                name: "Index Fund",
                symbol: "IDX",
                assetClass: "etf",
                total: 10,
              },
            ],
          },
        },
        { currency },
      ),
    pageBreak: false,
  },
  {
    name: "taxExecutiveSummary",
    render: () => renderTaxExecutiveSummary(taxData, { currency }),
    pageBreak: false,
  },
  {
    name: "taxTypeBreakdown",
    render: () => renderTaxTypeBreakdown(taxData, { currency }),
    pageBreak: false,
  },
  {
    name: "taxByAssetClass",
    render: () => renderTaxByAssetClass(taxData, { currency }),
    pageBreak: false,
  },
  {
    name: "taxMonthlyTrend",
    render: () => renderTaxMonthlyTrend(taxData, { currency }),
    pageBreak: false,
  },
  {
    name: "topInvestmentsByCost",
    render: () => renderTopInvestmentsByCost(taxData, { currency }),
    pageBreak: false,
  },
  {
    name: "feeBreakdown",
    render: () => renderFeeBreakdown(taxData, { currency }),
    pageBreak: false,
  },
  {
    name: "belgianRulesSummary",
    render: () => renderBelgianRulesSummary(taxData, { currency }),
    pageBreak: false,
  },
];
const POPULATED_BODY_MARKERS = {
  executiveSummary: "Total Income",
  cashflowTrend: '<div class="chart-wrap">',
  categoryBreakdown: "<td>Food</td>",
  topRecipients: "<td>Shop</td>",
  bankBalances: "Checking",
  rollingAverages: "Avg Daily Spend (6mo)",
  plannedOutlook: "Landlord",
  portfolioExecutiveSummary: "<td>Index Fund</td>",
  portfolioAllocation: "<td>ETFs</td>",
  topHoldings: "<td>IDX</td>",
  performanceTrend: "Portfolio Value",
  assetClassDetail: "<td>ETFs</td>",
  dividendIncome: "Total Dividends",
  taxExecutiveSummary: "Total Taxes Paid",
  taxTypeBreakdown: "TOB (Transaction Tax)",
  taxByAssetClass: "<td>ETFs</td>",
  taxMonthlyTrend: "Jan'26",
  topInvestmentsByCost: "<td>Index Fund</td>",
  feeBreakdown: "Total fees:",
  belgianRulesSummary: "Dividend Tax",
};

describe("report section scaffolding", () => {
  it("escapes page labels, preserves trusted content, and applies page breaks centrally", () => {
    const html = sectionPage({
      title: "<Title>",
      subtitle: "A & B",
      content: '<table data-test="trusted"></table>',
      pageBreak: true,
    });

    expect(html).toContain('class="page page-break"');
    expect(html).toContain("&lt;Title&gt;");
    expect(html).toContain("A &amp; B");
    expect(html).toContain('<table data-test="trusted"></table>');
    expect(html.match(/section-divider/g)).toHaveLength(1);
  });

  it("keeps the established plain and headed empty-state styles", () => {
    expect(
      emptySection({ title: "Plain", subtitle: "Sub", message: "<none>" }),
    ).toContain('<div class="empty-notice">&lt;none&gt;</div>');
    expect(
      emptySection({
        title: "Headed",
        subtitle: "Sub",
        heading: "<None>",
        message: "Try & retry",
      }),
    ).toContain(
      '<div class="placeholder-notice"><strong>&lt;None&gt;</strong>Try &amp; retry</div>',
    );
  });

  it("gives every empty renderer exactly one canonical title, subtitle, and divider", () => {
    expect(EMPTY_RENDERERS).toHaveLength(20);
    for (const [index, render] of EMPTY_RENDERERS.entries()) {
      const name = EMPTY_RENDERER_NAMES[index];
      const html = render();
      expect(html.match(/class="section-title"/g), name).toHaveLength(1);
      expect(html.match(/class="section-subtitle"/g), name).toHaveLength(1);
      expect(html.match(/class="section-divider"/g), name).toHaveLength(1);
      expect(html.includes('class="page page-break"'), name).toBe(
        EMPTY_PAGE_BREAKS.has(name),
      );
    }
  });

  it("pins populated shell, page-break, and continuation behavior for all 20 renderers", () => {
    expect(POPULATED_RENDERERS).toHaveLength(20);
    for (const {
      name,
      render,
      pageBreak,
      continuation = false,
    } of POPULATED_RENDERERS) {
      const html = render();
      expect(html.match(/class="section-title"/g), name).toHaveLength(1);
      expect(html.match(/class="section-subtitle"/g), name).toHaveLength(1);
      expect(html.match(/class="section-divider"/g), name).toHaveLength(1);
      expect(html.includes('class="page page-break"'), name).toBe(pageBreak);
      expect(html.includes('class="page-continuation"'), name).toBe(
        continuation,
      );
      expect(html, name).toContain(POPULATED_BODY_MARKERS[name]);
    }
  });

  it("pins asset-class labels and snapshot/breakdown bucket math", () => {
    expect(assetClassLabel("stock")).toBe("Stock");
    expect(assetClassLabel("stock", { plural: true })).toBe("Stocks");
    expect(assetClassLabel("etf")).toBe("ETF");
    expect(assetClassLabel("unknown")).toBe("unknown");

    expect(
      buildAssetClassBuckets(
        {
          stocks_etfs_value: "120",
          stocks_etfs_invested: "100",
          crypto_value: 0,
          crypto_invested: 0,
          metals_value: 5,
          metals_invested: 4,
          cash_value: 7,
        },
        [{ assetClass: "crypto", currentValue: 999, totalInvested: 999 }],
      ),
    ).toEqual([
      { label: "Stocks & ETFs", value: 120, invested: 100 },
      { label: "Metals", value: 5, invested: 4 },
      { label: "Cash / Savings", value: 7, invested: 7 },
    ]);

    expect(
      buildAssetClassBuckets(null, [
        { assetClass: "etf", currentValue: 10, totalInvested: 8 },
        { assetClass: "etf", currentValue: 5, totalInvested: 4 },
        { assetClass: "bond", currentValue: 7, totalInvested: 7 },
      ]),
    ).toEqual([
      { label: "ETFs", value: 15, invested: 12 },
      { label: "Bonds", value: 7, invested: 7 },
    ]);
  });

  it("pins filtered/all chart order, escaping, trusted charts, and notice grammar", () => {
    const pair = comparisonChartPair({
      filteredLabel: "Filtered <2>",
      filteredChart: '<svg id="filtered"></svg>',
      allLabel: "All & complete",
      allChart: '<svg id="all"></svg>',
    });
    expect(pair).toContain("Filtered &lt;2&gt;");
    expect(pair).toContain("All &amp; complete");
    expect(pair).toContain('<svg id="filtered"></svg>');
    expect(pair).toContain('<svg id="all"></svg>');
    expect(pair.indexOf("filtered")).toBeLessThan(pair.indexOf("all"));

    expect(
      filterNotice({
        filteredCount: 1,
        excludedCount: 2,
        singular: "category",
        plural: "categories",
      }),
    ).toBe(
      '<div class="filter-notice">Table shows 1 category matching active filters. 2 categories excluded — see "All data" chart above.</div>',
    );
    expect(
      filterNotice({
        filteredCount: 2,
        excludedCount: 1,
        singular: "recipient",
        plural: "recipients",
      }),
    ).toContain("2 recipients matching active filters. 1 recipient excluded");
  });

  it("keeps raw page scaffolding out of every section renderer", async () => {
    const sectionDirectory = fileURLToPath(
      new URL("../src/services/reports/sections/", import.meta.url),
    );
    const files = (await readdir(sectionDirectory)).filter((file) =>
      file.endsWith(".js"),
    );

    expect(files).toHaveLength(20);
    for (const file of files) {
      const source = await readFile(
        new URL(`../src/services/reports/sections/${file}`, import.meta.url),
        "utf8",
      );
      expect(
        source.match(/<div class="page(?: page-break)?">/),
        file,
      ).toBeNull();
      expect(source, file).not.toContain('<hr class="section-divider">');
      expect(source, file).not.toContain('class="empty-notice"');
      expect(source, file).not.toContain('class="placeholder-notice"');
      expect(source, file).not.toContain('class="chart-pair"');
      expect(source, file).not.toContain('class="filter-notice"');
      expect(source, file).not.toContain("ASSET_CLASS_LABELS");
    }
  });
});

describe("portfolio breakdown normalization", () => {
  it("applies canonical defaults at the portfolio report boundary", () => {
    expect(
      normalizeBreakdownRow({
        assetClass: "etf",
        currentValue: 10,
        totalInvested: 7,
        gainLoss: 3,
        gainLossPercent: 42,
      }),
    ).toMatchObject({
      assetClass: "etf",
      currentValue: 10,
      totalInvested: 7,
      gainLoss: 3,
      gainLossPercent: 42,
    });
  });

  it("is wired into the portfolio fetch boundary", async () => {
    const source = await readFile(
      new URL(
        "../src/services/reports/dataFetcherPortfolio.js",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain(
      "rawBreakdown?.map(normalizeBreakdownRow) ?? rawBreakdown",
    );
  });
});

describe("portfolio report view models", () => {
  it("deduplicates monthly snapshots at the data boundary and caps table rows", () => {
    const snapshots = Array.from({ length: 14 }, (_, index) => {
      const year = 2025 + Math.floor(index / 12);
      const month = (index % 12) + 1;
      return {
        snapshot_date: `${year}-${String(month).padStart(2, "0")}-01`,
        value: index + 10,
        invested: index,
        return_pct: index,
      };
    }).reverse();
    snapshots.push({
      snapshot_date: "2025-01-31",
      value: 99,
      invested: 50,
      return_pct: 98,
    });

    const trend = buildPerformanceTrendData(snapshots);

    expect(trend.points).toHaveLength(14);
    expect(
      trend.points.map(
        (point) => `${point.year}-${String(point.month).padStart(2, "0")}`,
      ),
    ).toEqual([
      "2025-01",
      "2025-02",
      "2025-03",
      "2025-04",
      "2025-05",
      "2025-06",
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
    expect(trend.points[0]).toMatchObject({
      year: 2025,
      month: 1,
      value: 99,
      invested: 50,
      gainLoss: 49,
      returnPct: 98,
    });
    expect(trend.tablePoints).toHaveLength(12);
    expect(trend.tablePoints[0].month).toBe(3);
  });

  it("builds portfolio KPIs and top holdings at the data boundary", () => {
    const investments = Array.from({ length: 7 }, (_, index) => ({
      name: `Holding ${index}`,
      currentValue: index + 1,
      totalInvested: index,
      gainLoss: 1,
    }));

    const summary = buildPortfolioExecutiveSummaryData(
      investments,
      [{ return_pct: 12, inflation_adjusted_value: 27 }],
      { byMonth: [{ amount: 2 }, { amount: 3 }], byInvestment: [] },
    );

    expect(summary).toMatchObject({
      totalValue: 28,
      totalInvested: 21,
      totalGainLoss: 7,
      returnPct: 12,
      inflationAdjustedValue: 27,
      totalDividends: 5,
      holdingsCount: 7,
    });
    expect(summary.topHoldings.map((holding) => holding.currentValue)).toEqual([
      7, 6, 5, 4, 3,
    ]);
  });
});
