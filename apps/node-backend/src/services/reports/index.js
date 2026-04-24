/**
 * Report generation dispatcher.
 *
 * Entry point for all PDF report types. Each report type (financial, portfolio,
 * tax) builds an HTML document from theme tokens + data, then Puppeteer renders
 * it to a PDF buffer that is piped to the HTTP response.
 *
 * Phase 1: Cover page + placeholder sections. Section renderers added in phase 3.
 */

import { renderHtmlToPdf } from './puppeteerRenderer.js';
import { buildThemeCss } from './themeCss.js';
import { escapeHtml, SECTION_CSS } from './sectionHelpers.js';
import { fetchFinancialData } from './dataFetcher.js';
import { renderExecutiveSummary } from './sections/executiveSummary.js';
import { renderCashflowTrend } from './sections/cashflowTrend.js';
import { renderCategoryBreakdown } from './sections/categoryBreakdown.js';
import { renderTopRecipients } from './sections/topRecipients.js';
import { renderBankBalances } from './sections/bankBalances.js';
import { renderPlannedOutlook } from './sections/plannedOutlook.js';
import { renderRollingAverages } from './sections/rollingAverages.js';

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
  const now = new Date();
  switch (period.kind) {
    case 'ytd':
      return `Year to Date (${now.getFullYear()})`;
    case 'rolling':
      return `Last ${period.months} month${period.months === 1 ? '' : 's'}`;
    case 'custom': {
      const fmt = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
    @page { size: A4 portrait; margin: 0; }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

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
      padding: 40px 52px;
      border-top: 4px solid hsl(var(--primary));
      /* intentionally no break-inside: avoid — sections may span pages */
    }
    .page-break {
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

  return `
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
      border-top: 1px solid ${border};
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
 */
function buildCoverHtml({ type, currency, period, generatedAt }) {
  const title = REPORT_TITLES[type] ?? 'Report';
  const subtitle = REPORT_SUBTITLES[type] ?? '';
  const periodStr = formatPeriod(period);
  const dateStr = new Date(generatedAt).toLocaleDateString('en-US', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

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
        </div>
        <div class="cover-footer">
          <span class="cover-footer-brand">Vision</span>
          <span>Confidential · ${escapeHtml(new Date(generatedAt).getFullYear().toString())}</span>
        </div>
      </div>
    </div>
  `.trim();
}

/**
 * Map of financial section IDs to their renderer functions.
 * Renderers receive (data, { currency, period }) and return an HTML string.
 */
const FINANCIAL_SECTION_RENDERERS = {
  executiveSummary: renderExecutiveSummary,
  cashflowTrend: renderCashflowTrend,
  categoryBreakdown: renderCategoryBreakdown,
  topRecipients: renderTopRecipients,
  bankBalances: renderBankBalances,
  plannedOutlook: renderPlannedOutlook,
  rollingAverages: renderRollingAverages,
};

/** Sections rendered when no explicit list is requested. */
const DEFAULT_FINANCIAL_SECTIONS = [
  'executiveSummary',
  'cashflowTrend',
  'categoryBreakdown',
  'topRecipients',
  'bankBalances',
  'rollingAverages',
  'plannedOutlook',
];

/**
 * Build the body HTML for a financial report.
 *
 * @param {{ currency: string; period: Period; sections: string[] }} opts
 * @returns {Promise<string>}
 */
async function buildFinancialBody({ currency, period, sections }) {
  const requested = sections.length > 0 ? sections : DEFAULT_FINANCIAL_SECTIONS;
  const valid = requested.filter(id => id in FINANCIAL_SECTION_RENDERERS);

  if (!valid.length) {
    return `
      <div class="page placeholder-notice">
        <strong>No sections selected</strong>
        Select sections in the export dialog to include them in this report.
      </div>`;
  }

  const data = await fetchFinancialData(currency);

  return valid
    .map(id => FINANCIAL_SECTION_RENDERERS[id](data, { currency, period }))
    .join('\n');
}

/**
 * Placeholder body for report types not yet implemented (portfolio, tax).
 */
function buildPlaceholderBody(sections) {
  return `
    <div class="page placeholder-notice">
      <strong>Coming soon</strong>
      This report type is not yet available.
      ${sections.length > 0 ? `<br>Requested sections: ${sections.map(escapeHtml).join(', ')}.` : ''}
    </div>`;
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
export async function generateReport({ type, currency, period, sections, theme, res }) {
  const generatedAt = new Date().toISOString();
  const mode = theme.mode ?? 'light';

  const themeCss = buildThemeCss(theme);
  const baseCss = buildBaseCss();
  const coverHtml = buildCoverHtml({ type, currency, period, generatedAt });

  let bodyHtml;
  if (type === 'financial') {
    bodyHtml = await buildFinancialBody({ currency, period, sections });
  } else {
    bodyHtml = buildPlaceholderBody(sections);
  }

  const html = buildDocument({ themeCss, baseCss, body: coverHtml + '\n' + bodyHtml, mode });

  const footerTemplate = buildFooterTemplate(theme);
  const pdf = await renderHtmlToPdf(html, {
    footerTemplate,
    margin: { top: '0', right: '0', bottom: '28px', left: '0' },
  });

  const date = new Date(generatedAt).toISOString().slice(0, 10);
  const filename = `vision-${type}-${date}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdf.length);
  res.end(pdf);
}
