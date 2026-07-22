/**
 * Single source of truth for report-section identity: the ID, canonical order,
 * and default-membership of every section, per report type.
 *
 * This is deliberately a dependency-free data leaf — it imports no render
 * functions, so the FE↔BE drift guard (tests/reportSectionCatalog.test.js) and
 * (transitively) the frontend export dialog can pin the section contract
 * without loading the heavy Puppeteer/HTML render graph. index.js zips these
 * catalogs with its renderer maps and throws at module load if the two ever
 * disagree (a section with no renderer, or a renderer with no catalog entry),
 * so identity lives here and rendering lives there, cross-checked on boot.
 *
 * Array order is canonical: sections render in this order when a request omits
 * `sections`, and the frontend export dialog lists them in this order
 * (apps/frontend/src/components/reports/reportSections.ts mirrors the IDs).
 * `default: true` marks sections rendered when the request omits `sections`.
 */

/** @typedef {{ id: string; default: boolean }} SectionEntry */

/** @type {SectionEntry[]} */
export const FINANCIAL_SECTION_CATALOG = [
  { id: 'executiveSummary',  default: true },
  { id: 'cashflowTrend',     default: true },
  { id: 'categoryBreakdown', default: true },
  { id: 'topRecipients',     default: true },
  { id: 'bankBalances',      default: true },
  { id: 'rollingAverages',   default: true },
  { id: 'plannedOutlook',    default: true },
];

/** @type {SectionEntry[]} */
export const PORTFOLIO_SECTION_CATALOG = [
  { id: 'portfolioExecutiveSummary', default: true },
  { id: 'portfolioAllocation',       default: true },
  { id: 'topHoldings',               default: true },
  { id: 'performanceTrend',          default: true },
  { id: 'assetClassDetail',          default: true },
  { id: 'dividendIncome',            default: true },
];

/** @type {SectionEntry[]} */
export const TAX_SECTION_CATALOG = [
  { id: 'taxExecutiveSummary',  default: true },
  { id: 'taxTypeBreakdown',     default: true },
  { id: 'taxByAssetClass',      default: true },
  { id: 'taxMonthlyTrend',      default: true },
  { id: 'topInvestmentsByCost', default: true },
  { id: 'feeBreakdown',         default: true },
  { id: 'belgianRulesSummary',  default: true },
];
