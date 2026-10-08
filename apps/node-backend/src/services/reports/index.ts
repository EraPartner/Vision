/**
 * Report generation dispatcher.
 *
 * Entry point for all PDF report types. Each report type (financial, portfolio,
 * tax) builds an HTML document from theme tokens + data, then Puppeteer renders
 * it to a PDF buffer returned to the HTTP route.
 */

import { renderHtmlToPdf } from './puppeteerRenderer.ts';
import { toAppDateString, toAppTz, APP_TIMEZONE } from '../../lib/timezone.ts';
import { buildThemeCss } from './themeCss.ts';
import { escapeHtml, SECTION_CSS } from './sectionHelpers.ts';
import { fetchFinancialData } from './dataFetcher.ts';
import { fetchPortfolioData } from './dataFetcherPortfolio.ts';
import { fetchTaxData } from './dataFetcherTax.ts';
import { renderExecutiveSummary } from './sections/executiveSummary.ts';
import { renderCashflowTrend } from './sections/cashflowTrend.ts';
import { renderCategoryBreakdown } from './sections/categoryBreakdown.ts';
import { renderTopRecipients } from './sections/topRecipients.ts';
import { renderBankBalances } from './sections/bankBalances.ts';
import { renderPlannedOutlook } from './sections/plannedOutlook.ts';
import { renderRollingAverages } from './sections/rollingAverages.ts';
import { renderPortfolioExecutiveSummary } from './sections/portfolioExecutiveSummary.ts';
import { renderPortfolioAllocation } from './sections/portfolioAllocation.ts';
import { renderTopHoldings } from './sections/topHoldings.ts';
import { renderPerformanceTrend } from './sections/performanceTrend.ts';
import { renderAssetClassDetail } from './sections/assetClassDetail.ts';
import { renderDividendIncome } from './sections/dividendIncome.ts';
import { renderTaxExecutiveSummary } from './sections/taxExecutiveSummary.ts';
import { renderTaxTypeBreakdown } from './sections/taxTypeBreakdown.ts';
import { renderFeeBreakdown } from './sections/feeBreakdown.ts';
import { renderTaxByAssetClass } from './sections/taxByAssetClass.ts';
import { renderTaxMonthlyTrend } from './sections/taxMonthlyTrend.ts';
import { renderTopInvestmentsByCost } from './sections/topInvestmentsByCost.ts';
import { renderBelgianRulesSummary } from './sections/belgianRulesSummary.ts';
import {
  FINANCIAL_SECTION_CATALOG,
  PORTFOLIO_SECTION_CATALOG,
  TAX_SECTION_CATALOG,
} from './sectionCatalog.ts';
import investmentRepository from '../../repositories/investmentRepository.ts';
import type { FinancialReportData, Period } from './dataFetcher.ts';
import type { PortfolioReportData } from './dataFetcherPortfolio.ts';
import type {
  PrecomputedPIT,
  TaxProfile,
  TaxReportData,
} from './dataFetcherTax.ts';
import type { SectionEntry } from './sectionCatalog.ts';

export type { Period, PrecomputedPIT, TaxProfile };

export type PeriodKind = Period['kind'];

export type ThemeTokens = {
  primary?: string;
  accent?: string;
  success?: string;
  expense?: string;
  surface?: string;
  text?: string;
  muted?: string;
  border?: string;
  chart1?: string; chart2?: string; chart3?: string; chart4?: string;
  chart5?: string; chart6?: string; chart7?: string; chart8?: string;
  mode?: 'light' | 'dark';
};

export type GenerateReportOpts = {
  type: 'financial' | 'portfolio' | 'tax';
  currency: string;
  period: Period;
  sections: string[];
  theme: ThemeTokens;
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
  taxProfile?: TaxProfile;
  precomputedPIT?: PrecomputedPIT;
};

const REPORT_TITLES: Record<string, string> = {
  financial: 'Financial Report',
  portfolio: 'Portfolio Report',
  tax: 'Tax Report',
};

const REPORT_SUBTITLES: Record<string, string> = {
  financial: 'Transactions, cashflow, categories & recipients',
  portfolio: 'Holdings, allocation & performance',
  tax: 'Tax-year breakdown & deductible transactions',
};

/** Format a period descriptor into a human-readable string. */
function formatPeriod(period: Period): string {
  switch (period.kind) {
    case 'ytd':
      return `Year to Date (${toAppTz(new Date()).year})`;
    case 'rolling':
      return `Last ${period.months} month${period.months === 1 ? '' : 's'}`;
    case 'custom': {
      // `from`/`to` are calendar dates; new Date('YYYY-MM-DD') is UTC midnight,
      // so format in UTC or a zone west of UTC shows the previous day.
      const fmt = (d: string) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
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
function buildBaseCss(): string {
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
 */
function buildFooterTemplate(theme: ThemeTokens): string {
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

/** Build the cover page HTML for any report type. */
function buildCoverHtml({
  type,
  currency,
  period,
  generatedAt,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  pricesAsOf = null,
}: {
  type: string;
  currency: string;
  period: Period;
  generatedAt: string;
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
  pricesAsOf?: Date | string | null;
}): string {
  const title = REPORT_TITLES[type] ?? 'Report';
  const subtitle = REPORT_SUBTITLES[type] ?? '';
  const periodStr = formatPeriod(period);
  const dateStr = new Date(generatedAt).toLocaleDateString('en-US', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: APP_TIMEZONE,
  });

  const filterParts: string[] = [];
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

/** The context every section renderer receives alongside its data. */
export type SectionContext = { currency: string; period: Period };

/**
 * A section renderer for one report type's data payload. Defaults to
 * `unknown` data for code that only routes renderers without calling them.
 */
export type SectionRenderer<D = unknown> = (data: D, ctx: SectionContext) => string;

/*
 * id -> renderer, per report type. sectionCatalog.js owns the canonical
 * section IDs, order, and default membership (the surface the frontend export
 * dialog mirrors); these maps own only the id->render wiring. reconcile()
 * below zips the two at module load and throws if they disagree, so a section
 * with no renderer — or a renderer with no catalog entry — fails fast on boot
 * instead of silently dropping a section at request time. To add, remove, or
 * reorder a section, edit its sectionCatalog.js array and this map together.
 */

const FINANCIAL_SECTION_RENDERERS: Record<string, SectionRenderer<FinancialReportData>> = {
  executiveSummary:  renderExecutiveSummary,
  cashflowTrend:     renderCashflowTrend,
  categoryBreakdown: renderCategoryBreakdown,
  topRecipients:     renderTopRecipients,
  bankBalances:      renderBankBalances,
  rollingAverages:   renderRollingAverages,
  plannedOutlook:    renderPlannedOutlook,
};

const PORTFOLIO_SECTION_RENDERERS: Record<string, SectionRenderer<PortfolioReportData>> = {
  portfolioExecutiveSummary: renderPortfolioExecutiveSummary,
  portfolioAllocation:       renderPortfolioAllocation,
  topHoldings:               renderTopHoldings,
  performanceTrend:          renderPerformanceTrend,
  assetClassDetail:          renderAssetClassDetail,
  dividendIncome:            renderDividendIncome,
};

const TAX_SECTION_RENDERERS: Record<string, SectionRenderer<TaxReportData>> = {
  taxExecutiveSummary:  renderTaxExecutiveSummary,
  taxTypeBreakdown:     renderTaxTypeBreakdown,
  taxByAssetClass:      renderTaxByAssetClass,
  taxMonthlyTrend:      renderTaxMonthlyTrend,
  topInvestmentsByCost: renderTopInvestmentsByCost,
  feeBreakdown:         renderFeeBreakdown,
  belgianRulesSummary:  renderBelgianRulesSummary,
};

/**
 * Cross-check a section catalog against its renderer map and return the
 * catalog's default-section IDs in canonical order. Throws at module load if
 * the two ever drift so a wiring mistake surfaces on boot, not as a silently
 * omitted section at request time.
 *
 * @returns default section IDs, in order
 */
function reconcile(
  catalog: SectionEntry[],
  renderers: Record<string, unknown>,
  label: string,
): string[] {
  const catalogIds = catalog.map((s) => s.id);
  const missing = catalogIds.filter((id) => !(id in renderers));
  const orphan = Object.keys(renderers).filter((id) => !catalogIds.includes(id));
  if (missing.length) throw new Error(`${label} report sections without a renderer: ${missing.join(', ')}`);
  if (orphan.length) throw new Error(`${label} report renderers without a catalog entry: ${orphan.join(', ')}`);
  return catalog.filter((s) => s.default).map((s) => s.id);
}

const DEFAULT_FINANCIAL_SECTIONS = reconcile(FINANCIAL_SECTION_CATALOG, FINANCIAL_SECTION_RENDERERS, 'financial');
const DEFAULT_PORTFOLIO_SECTIONS = reconcile(PORTFOLIO_SECTION_CATALOG, PORTFOLIO_SECTION_RENDERERS, 'portfolio');
const DEFAULT_TAX_SECTIONS       = reconcile(TAX_SECTION_CATALOG, TAX_SECTION_RENDERERS, 'tax');

/**
 * Shared report-body builder. Picks the requested sections (or the type's
 * defaults), renders each with the type's renderer map, and joins them.
 * Emits the shared "no sections selected" placeholder when nothing valid
 * remains, so the (previously triplicated) placeholder lives in one place.
 */
async function buildBody<D>({
  currency,
  period,
  sections,
  renderers,
  defaultSections,
  fetchData,
  separator = '\n',
}: {
  currency: string;
  period: Period;
  sections: string[];
  renderers: Record<string, SectionRenderer<D>>;
  defaultSections: string[];
  fetchData: (sections: string[]) => Promise<D>;
  separator?: string;
}): Promise<string> {
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

function buildFinancialBody({
  currency,
  period,
  sections,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
}: {
  currency: string;
  period: Period;
  sections: string[];
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
}): Promise<string> {
  return buildBody({
    currency,
    period,
    sections,
    renderers: FINANCIAL_SECTION_RENDERERS,
    defaultSections: DEFAULT_FINANCIAL_SECTIONS,
    fetchData: (validSections) => fetchFinancialData(currency, { excludedCategoryIds, excludedRecipientIds, sections: validSections }),
  });
}

function buildPortfolioBody({
  currency,
  period,
  sections,
}: {
  currency: string;
  period: Period;
  sections: string[];
}): Promise<string> {
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

function buildTaxBody({
  currency,
  period,
  sections,
  taxProfile,
  precomputedPIT,
}: {
  currency: string;
  period: Period;
  sections: string[];
  taxProfile?: TaxProfile;
  precomputedPIT?: PrecomputedPIT;
}): Promise<string> {
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

/** Assemble a complete HTML document for PDF rendering. */
function buildDocument({
  themeCss,
  baseCss,
  body,
  mode,
}: {
  themeCss: string;
  baseCss: string;
  body: string;
  mode: 'light' | 'dark';
}): string {
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

/** Generate a PDF report for the HTTP route to send. */
export async function generateReport({
  type,
  currency,
  period,
  sections,
  theme,
  excludedCategoryIds = [],
  excludedRecipientIds = [],
  taxProfile,
  precomputedPIT,
}: GenerateReportOpts): Promise<{ pdf: Buffer; filename: string }> {
  const generatedAt = new Date().toISOString();
  const mode = theme.mode ?? 'light';

  const themeCss = buildThemeCss(theme);
  const baseCss = buildBaseCss();
  const pricesAsOf = (type === 'portfolio' || type === 'tax')
    ? await investmentRepository.getLatestPriceUpdatedAt().catch((): Date | null => null)
    : null;
  const coverHtml = buildCoverHtml({ type, currency, period, generatedAt, excludedCategoryIds, excludedRecipientIds, pricesAsOf });

  let bodyHtml: string;
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

  return { pdf, filename };
}
