/**
 * Report generation dispatcher.
 *
 * Entry point for all PDF report types. Each report type (financial, portfolio,
 * tax) builds an HTML document from theme tokens + data, then Puppeteer renders
 * it to a PDF buffer that is piped to the HTTP response.
 */

import { renderHtmlToPdf } from './puppeteerRenderer.js';
import { toAppDateString, toAppTz, APP_TIMEZONE } from '../../lib/timezone.js';
import { buildThemeCss } from './themeCss.js';
import { escapeHtml, SECTION_CSS } from './sectionHelpers.js';
import { fetchFinancialData } from './dataFetcher.js';
import { fetchPortfolioData } from './dataFetcherPortfolio.js';
import { fetchTaxData } from './dataFetcherTax.js';
import { renderExecutiveSummary } from './sections/executiveSummary.js';
import { renderCashflowTrend } from './sections/cashflowTrend.js';
import { renderCategoryBreakdown } from './sections/categoryBreakdown.js';
import { renderTopRecipients } from './sections/topRecipients.js';
import { renderBankBalances } from './sections/bankBalances.js';
import { renderPlannedOutlook } from './sections/plannedOutlook.js';
import { renderRollingAverages } from './sections/rollingAverages.js';
import { renderPortfolioExecutiveSummary } from './sections/portfolioExecutiveSummary.js';
import { renderPortfolioAllocation } from './sections/portfolioAllocation.js';
import { renderTopHoldings } from './sections/topHoldings.js';
import { renderPerformanceTrend } from './sections/performanceTrend.js';
import { renderAssetClassDetail } from './sections/assetClassDetail.js';
import { renderDividendIncome } from './sections/dividendIncome.js';
import { renderTaxExecutiveSummary } from './sections/taxExecutiveSummary.js';
import { renderTaxTypeBreakdown } from './sections/taxTypeBreakdown.js';
import { renderFeeBreakdown } from './sections/feeBreakdown.js';
import { renderTaxByAssetClass } from './sections/taxByAssetClass.js';
import { renderTaxMonthlyTrend } from './sections/taxMonthlyTrend.js';
import { renderTopInvestmentsByCost } from './sections/topInvestmentsByCost.js';
import { renderBelgianRulesSummary } from './sections/belgianRulesSummary.js';
import investmentRepository from '../../repositories/investmentRepository.js';

/**
 * @typedef {'ytd' | 'rolling' | 'custom' | 'year'} PeriodKind
 *
 * @typedef {{ kind: 'ytd' }
 *   | { kind: 'rolling'; months: number }
 *   | { kind: 'custom'; from: string; to: string }
 *   | { kind: 'year'; year: number }
 * } Period
 *
 * @typedef {{
 *   primary?: string;
 *   accent?: string;
 *   success?: string;
 *   expense?: string;
 *   surface?: string;
 *   text?: string;
 *   muted?: string;
 *   border?: string;
 *   chart1?: string; chart2?: string; chart3?: string; chart4?: string;
 *   chart5?: string; chart6?: string; chart7?: string; chart8?: string;
 *   mode?: 'light' | 'dark';
 * }} ThemeTokens
 *
 * @typedef {{
 *   type: 'financial' | 'portfolio' | 'tax';
 *   currency: string;
 *   period: Period;
 *   sections: string[];
 *   theme: ThemeTokens;
 *   res: import('express').Response;
 *   excludedCategoryIds?: number[];
 *   excludedRecipientIds?: number[];
 *   taxProfile?: object;
 *   precomputedPIT?: object;
 * }} GenerateReportOpts
 */

const REPORT_TITLES = {
  financial: 'Financial Report',
  portfolio: 'Portfolio Report',
  tax: 'Tax Report',
};

const REPORT_SUBTITLES = {
  financial: 'Transactions, cashflow, categories & recipients',
  portfolio: 'Holdings, allocation & performance',
  tax: 'Tax-year breakdown & deductible transactions',
};

/**
 * Format a period descriptor into a human-readable string.
 *
 * @param {Period} period
 * @returns {string}
 */
function formatPeriod(period) {
  switch (period.kind) {
    case 'ytd':
      return `Year to Date (${toAppTz(new Date()).year})`;
    case 'rolling':
      return `Last ${period.months} month${period.months === 1 ? '' : 's'}`;
    case 'custom': {
      const fmt = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: APP_TIMEZONE });
      return `${fmt(period.from)} – ${fmt(period.to)}`;
    }
    case 'year':
      return `${period.year}`;
    default:
      return 'All time';
  }
}

/**
 * Build the base print CSS that every report shares.
 * Uses CSS custom properties resolved from the theme tokens.
 */
function buildBaseCss() {
  return `
    /* @page background paints the entire page canvas including the bottom
       margin area reserved for the Puppeteer footer. Without it, Chromium
       leaves a white strip below the footer iframe (the iframe's allotted
       height is shorter than the @page bottom margin) and the html/body
       backgrounds do not propagate into @page margin boxes. */
    @page { size: A4 portrait; margin: 0 0 28px 0; background: hsl(var(--surface)); }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html {
      background: hsl(var(--surface));
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    :root {
      /* Height reserved for the Puppeteer footer in the bottom margin area.
         Must match the bottom margin passed to renderHtmlToPdf. */
      --footer-h: 28px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: hsl(var(--surface));
      color: hsl(var(--text));
      width: 210mm;
      font-size: 13px;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Cover ─────────────────────────────────────── */
    .cover {
      height: calc(297mm - var(--footer-h));
      display: flex;
      flex-direction: column;
      page-break-after: always;
      background: hsl(var(--surface));
    }
    .cover-band {
      height: 8px;
      background: hsl(var(--primary));
      flex-shrink: 0;
    }
    .cover-body {
      flex: 1;
      padding: 64px 52px 40px;
      display: flex;
      flex-direction: column;
    }
    .cover-eyebrow {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: hsl(var(--primary));
      margin-bottom: 12px;
    }
    .cover-title {
      font-size: 40px;
      font-weight: 700;
      color: hsl(var(--text));
      line-height: 1.1;
      margin-bottom: 10px;
    }
    .cover-subtitle {
      font-size: 15px;
      color: hsl(var(--muted));
      margin-bottom: 56px;
    }
    .cover-divider {
      width: 48px;
      height: 3px;
      background: hsl(var(--primary));
      border-radius: 2px;
      margin-bottom: 40px;
    }
    .cover-meta {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .meta-row {
      display: flex;
      align-items: baseline;
      gap: 16px;
    }
    .meta-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: hsl(var(--muted));
      width: 72px;
      flex-shrink: 0;
    }
    .meta-value {
      font-size: 14px;
      font-weight: 500;
      color: hsl(var(--text));
    }
    .cover-footer {
      margin-top: auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 24px;
      border-top: 1px solid hsl(var(--border));
      font-size: 10px;
      color: hsl(var(--muted));
    }
    .cover-footer-brand {
      font-weight: 600;
      color: hsl(var(--primary));
    }

    /* ── Content pages ─────────────────────────────── */
    .page {
      padding: 40px 52px 56px;
      border-top: 4px solid hsl(var(--primary));
      /* intentionally no break-inside: avoid — sections may span pages */
    }
    .page-break {
      page-break-before: always;
    }
    /* Continuation page within the same logical section — forced break.
       Same green top border as .page so every printed page has the brand band. */
    .page-continuation {
      padding: 40px 52px 56px;
      border-top: 4px solid hsl(var(--primary));
      page-break-before: always;
    }
    .section-title {
      font-size: 18px;
      font-weight: 700;
      color: hsl(var(--text));
      margin-bottom: 4px;
      break-after: avoid;
    }
    .section-subtitle {
      font-size: 12px;
      color: hsl(var(--muted));
      margin-bottom: 24px;
      break-after: avoid;
    }
    .section-divider {
      border: none;
      border-top: 1px solid hsl(var(--border));
      margin-bottom: 32px;
      break-after: avoid;
      page-break-after: avoid;
    }

    /* ── Placeholder (phase 1) ─────────────────────── */
    .placeholder-notice {
      text-align: center;
      padding: 80px 52px;
      color: hsl(var(--muted));
      font-size: 13px;
    }
    .placeholder-notice strong {
      display: block;
      font-size: 15px;
      color: hsl(var(--text));
      margin-bottom: 8px;
    }

    ${SECTION_CSS}
  `.trim();
}

/**
 * Build a Puppeteer footerTemplate HTML string.
 *
 * Puppeteer footer templates render in an isolated document — CSS custom
 * properties from the report HTML are unavailable. Theme colors are
 * interpolated directly as hsl() literals. The template uses the special
 * `.pageNumber` / `.totalPages` spans that Puppeteer populates automatically.
 *
 * @param {ThemeTokens} theme
 * @returns {string}
 */
function buildFooterTemplate(theme) {
  const primary = theme.primary ? `hsl(${theme.primary})` : '#5b7fa6';
  const muted   = theme.muted   ? `hsl(${theme.muted})`   : '#8a939f';
  const border  = theme.border  ? `hsl(${theme.border})`  : '#d1d5db';
  const surface = theme.surface ? `hsl(${theme.surface})` : '#ffffff';

  // Puppeteer's footer iframe wraps the template in a default <html><body>
  // with an 8 px body margin — zero it so the footer div fills the iframe
  // edge to edge. CRITICAL: do NOT set `background` on `html` here. Chromium
  // leaks top-level `html` rules from header/footer templates into the main
  // document, repainting the entire report and hiding cover/section content.
  // The page-bottom surface fill is owned by `@page { background }` in
  // buildBaseCss, not by this template.
  return `
    <style>html,body{margin:0;padding:0;}</style>
    <div style="
      box-sizing: border-box;
      width: 100%;
      height: 28px;
      padding: 0 52px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 9px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: ${muted};
      background-color: ${surface};
      border-top: 1px solid ${border};
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    ">
      <span style="font-weight: 600; color: ${primary};">Vision</span>
      <span>Confidential</span>
      <span>
        <span class="pageNumber"></span>&thinsp;/&thinsp;<span class="totalPages"></span>
      </span>
    </div>
  `.trim();
}

/**
 * Build the cover page HTML for any report type.
 *
 * @param {{ type: string; currency: string; period: Period; generatedAt: string; excludedCategoryIds?: number[]; excludedRecipientIds?: number[]; pricesAsOf?: string|null }} opts
 */
function buildCoverHtml({ type, currency, period, generatedAt, excludedCategoryIds = [], excludedRecipientIds = [], pricesAsOf = null }) {
  const title = REPORT_TITLES[type] ?? 'Report';
  const subtitle = REPORT_SUBTITLES[type] ?? '';
  const periodStr = formatPeriod(period);
  const dateStr = new Date(generatedAt).toLocaleDateString('en-US', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: APP_TIMEZONE,
  });

  const filterParts = [];
  if (excludedCategoryIds.length > 0) filterParts.push(`${excludedCategoryIds.length} categor${excludedCategoryIds.length === 1 ? 'y' : 'ies'} excluded`);
  if (excludedRecipientIds.length > 0) filterParts.push(`${excludedRecipientIds.length} recipient${excludedRecipientIds.length === 1 ? '' : 's'} excluded`);
  const filtersRow = filterParts.length > 0
    ? `<div class="meta-row">
            <span class="meta-label">Filters</span>
            <span class="meta-value">${escapeHtml(filterParts.join(', '))}</span>
          </div>`
    : '';

  let pricesRow = '';
  if (pricesAsOf) {
    const pricesAsOfDate = new Date(pricesAsOf);
    const pricesAsOfStr = pricesAsOfDate.toLocaleDateString('en-US', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: APP_TIMEZONE,
    });
    const ageDays = Math.floor((new Date(generatedAt).getTime() - pricesAsOfDate.getTime()) / (24 * 60 * 60 * 1000));
    const staleSuffix = ageDays > 1 ? ` (${ageDays} days old)` : '';
    pricesRow = `<div class="meta-row">
            <span class="meta-label">Prices as of</span>
            <span class="meta-value">${escapeHtml(pricesAsOfStr + staleSuffix)}</span>
          </div>`;
  } else if (type === 'portfolio' || type === 'tax') {
    pricesRow = `<div class="meta-row">
            <span class="meta-label">Prices as of</span>
            <span class="meta-value">No live prices recorded</span>
          </div>`;
  }

  return `
    <div class="cover">
      <div class="cover-band"></div>
      <div class="cover-body">
        <div class="cover-eyebrow">Vision</div>
        <div class="cover-title">${escapeHtml(title)}</div>
        <div class="cover-subtitle">${escapeHtml(subtitle)}</div>
        <div class="cover-divider"></div>
        <div class="cover-meta">
          <div class="meta-row">
            <span class="meta-label">Period</span>
            <span class="meta-value">${escapeHtml(periodStr)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Currency</span>
            <span class="meta-value">${escapeHtml(currency)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Generated</span>
            <span class="meta-value">${escapeHtml(dateStr)}</span>
          </div>
          ${pricesRow}
          ${filtersRow}
        </div>
        <div class="cover-footer">
          <span class="cover-footer-brand">Vision</span>
          <span>Confidential · ${escapeHtml(toAppTz(new Date(generatedAt)).year.toString())}</span>
        </div>
      </div>
    </div>
  `.trim();
}

/**
 * @typedef {{
 *   id: string;
 *   render: (data: any, ctx: { currency: string; period: Period }) => string;
 *   default: boolean;
 * }} ReportSection
 */

/*
 * Single source of truth for each report type's sections.
 *
 * Array order is the canonical section order: sections render in this order
 * when the request omits `sections`, and the frontend export dialog lists
 * them in this order (apps/frontend/src/components/reports/reportSections.ts
 * hand-mirrors the IDs; tests/reportSectionCatalog.test.js fails the build if
 * the two drift). `default: true` marks sections rendered when the request
 * omits `sections`. The renderer lookup maps and default-order lists are
 * DERIVED below — to add, remove, or reorder a section, edit only its array.
 */

/** @type {ReportSection[]} */
export const FINANCIAL_REPORT_SECTIONS = [
  { id: 'executiveSummary',  render: renderExecutiveSummary,  default: true },
  { id: 'cashflowTrend',     render: renderCashflowTrend,     default: true },
  { id: 'categoryBreakdown', render: renderCategoryBreakdown, default: true },
  { id: 'topRecipients',     render: renderTopRecipients,     default: true },
  { id: 'bankBalances',      render: renderBankBalances,      default: true },
  { id: 'rollingAverages',   render: renderRollingAverages,   default: true },
  { id: 'plannedOutlook',    render: renderPlannedOutlook,    default: true },
];

/** @type {ReportSection[]} */
export const PORTFOLIO_REPORT_SECTIONS = [
  { id: 'portfolioExecutiveSummary', render: renderPortfolioExecutiveSummary, default: true },
  { id: 'portfolioAllocation',       render: renderPortfolioAllocation,       default: true },
  { id: 'topHoldings',               render: renderTopHoldings,               default: true },
  { id: 'performanceTrend',          render: renderPerformanceTrend,          default: true },
  { id: 'assetClassDetail',          render: renderAssetClassDetail,          default: true },
  { id: 'dividendIncome',            render: renderDividendIncome,            default: true },
];

/** @type {ReportSection[]} */
export const TAX_REPORT_SECTIONS = [
  { id: 'taxExecutiveSummary',  render: renderTaxExecutiveSummary,  default: true },
  { id: 'taxTypeBreakdown',     render: renderTaxTypeBreakdown,     default: true },
  { id: 'taxByAssetClass',      render: renderTaxByAssetClass,      default: true },
  { id: 'taxMonthlyTrend',      render: renderTaxMonthlyTrend,      default: true },
  { id: 'topInvestmentsByCost', render: renderTopInvestmentsByCost, default: true },
  { id: 'feeBreakdown',         render: renderFeeBreakdown,         default: true },
  { id: 'belgianRulesSummary',  render: renderBelgianRulesSummary,  default: true },
];

/** @param {ReportSection[]} sections @returns {Record<string, ReportSection['render']>} */
const toRenderers = (sections) => Object.fromEntries(sections.map(({ id, render }) => [id, render]));

/** @param {ReportSection[]} sections @returns {string[]} */
const toDefaultIds = (sections) => sections.filter((s) => s.default).map((s) => s.id);

const FINANCIAL_SECTION_RENDERERS = toRenderers(FINANCIAL_REPORT_SECTIONS);
const DEFAULT_FINANCIAL_SECTIONS  = toDefaultIds(FINANCIAL_REPORT_SECTIONS);

const PORTFOLIO_SECTION_RENDERERS = toRenderers(PORTFOLIO_REPORT_SECTIONS);
const DEFAULT_PORTFOLIO_SECTIONS  = toDefaultIds(PORTFOLIO_REPORT_SECTIONS);

const TAX_SECTION_RENDERERS = toRenderers(TAX_REPORT_SECTIONS);
const DEFAULT_TAX_SECTIONS  = toDefaultIds(TAX_REPORT_SECTIONS);

/**
 * Shared report-body builder. Picks the requested sections (or the type's
 * defaults), renders each with the type's renderer map, and joins them.
 * Emits the shared "no sections selected" placeholder when nothing valid
 * remains, so the (previously triplicated) placeholder lives in one place.
 *
 * @param {{
 *   currency: string;
 *   period: Period;
 *   sections: string[];
 *   renderers: Record<string, (data: any, ctx: { currency: string; period: Period }) => string>;
 *   defaultSections: string[];
 *   fetchData: (sections: string[]) => Promise<any>;
 *   separator?: string;
 * }} opts
 * @returns {Promise<string>}
 */
async function buildBody({ currency, period, sections, renderers, defaultSections, fetchData, separator = '\n' }) {
  const requested = sections.length > 0 ? sections : defaultSections;
  const valid = requested.filter(id => id in renderers);

  if (!valid.length) {
    return `
      <div class="page placeholder-notice">
        <strong>No sections selected</strong>
        Select sections in the export dialog to include them in this report.
      </div>`;
  }

  const data = await fetchData(valid);

  return valid
    .map(id => renderers[id](data, { currency, period }))
    .join(separator);
}

/**
 * @param {{ currency: string; period: Period; sections: string[]; excludedCategoryIds?: number[]; excludedRecipientIds?: number[] }} opts
 * @returns {Promise<string>}
 */
function buildFinancialBody({ currency, period, sections, excludedCategoryIds = [], excludedRecipientIds = [] }) {
  return buildBody({
    currency,
    period,
    sections,
    renderers: FINANCIAL_SECTION_RENDERERS,
    defaultSections: DEFAULT_FINANCIAL_SECTIONS,
    fetchData: (validSections) => fetchFinancialData(currency, { excludedCategoryIds, excludedRecipientIds, sections: validSections }),
  });
}

/**
 * @param {{ currency: string; period: Period; sections: string[] }} opts
 * @returns {Promise<string>}
 */
function buildPortfolioBody({ currency, period, sections }) {
  return buildBody({
    currency,
    period,
    sections,
    renderers: PORTFOLIO_SECTION_RENDERERS,
    defaultSections: DEFAULT_PORTFOLIO_SECTIONS,
    fetchData: () => fetchPortfolioData(currency, period),
    separator: '\n<div class="page-break"></div>\n',
  });
}

/**
 * @param {{ currency: string; period: Period; sections: string[]; taxProfile?: object; precomputedPIT?: object }} opts
 * @returns {Promise<string>}
 */
function buildTaxBody({ currency, period, sections, taxProfile, precomputedPIT }) {
  return buildBody({
    currency,
    period,
    sections,
    renderers: TAX_SECTION_RENDERERS,
    defaultSections: DEFAULT_TAX_SECTIONS,
    fetchData: () => fetchTaxData(currency, period, { taxProfile, precomputedPIT }),
    separator: '\n<div class="page-break"></div>\n',
  });
}

/**
 * Assemble a complete HTML document for PDF rendering.
 */
function buildDocument({ themeCss, baseCss, body, mode }) {
  return `<!DOCTYPE html>
<html class="${mode === 'dark' ? 'dark' : ''}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
${themeCss}
${baseCss}
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Generate a PDF report and pipe it to the HTTP response.
 *
 * @param {GenerateReportOpts} opts
 */
export async function generateReport({ type, currency, period, sections, theme, res, excludedCategoryIds = [], excludedRecipientIds = [], taxProfile, precomputedPIT }) {
  const generatedAt = new Date().toISOString();
  const mode = theme.mode ?? 'light';

  const themeCss = buildThemeCss(theme);
  const baseCss = buildBaseCss();
  const pricesAsOf = (type === 'portfolio' || type === 'tax')
    ? await investmentRepository.getLatestPriceUpdatedAt().catch(() => null)
    : null;
  const coverHtml = buildCoverHtml({ type, currency, period, generatedAt, excludedCategoryIds, excludedRecipientIds, pricesAsOf });

  let bodyHtml;
  if (type === 'financial') {
    bodyHtml = await buildFinancialBody({ currency, period, sections, excludedCategoryIds, excludedRecipientIds });
  } else if (type === 'portfolio') {
    bodyHtml = await buildPortfolioBody({ currency, period, sections });
  } else if (type === 'tax') {
    bodyHtml = await buildTaxBody({ currency, period, sections, taxProfile, precomputedPIT });
  } else {
    bodyHtml = `
      <div class="page placeholder-notice">
        <strong>Unknown report type</strong>
        Report type "${escapeHtml(String(type))}" is not supported.
      </div>`;
  }

  const html = buildDocument({ themeCss, baseCss, body: coverHtml + '\n' + bodyHtml, mode });

  const footerTemplate = buildFooterTemplate(theme);
  const pdf = await renderHtmlToPdf(html, {
    footerTemplate,
    margin: { top: '0', right: '0', bottom: '28px', left: '0' },
  });

  // App-timezone date for the filename — the UTC slice named a report
  // generated shortly after local midnight with yesterday's date.
  const date = toAppDateString(new Date(generatedAt));
  const filename = `vision-${type}-${date}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdf.length);
  res.end(pdf);
}
