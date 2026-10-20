/**
 * Report API — PDF export helpers (ADR-234).
 *
 * All three report types use POST so the frontend can forward resolved CSS
 * theme tokens, period selection, and section flags in the request body.
 * The backend answers with a print-ready document, not a PDF. Inside the
 * desktop shell, Electron prints it to PDF with its own Chromium and the file
 * downloads. In a plain browser the document opens the browser's print dialog,
 * where the user saves it as a PDF (no page-number footer there).
 */

import { resolveActiveThemeTokens, type ReportThemeTokens } from '@/lib/themeTokens';
import { downloadBlob } from '@/lib/downloadBlob';
import { checkResponseContract, unwrapEnvelope } from '@/lib/api/client';
import { ReportDocumentSchema, type ReportDocument } from '@vision/types/contracts';
import type { BelgianTaxHouseholdV2, PartnerId } from '@/lib/belgianTax/householdTypes';
import type {
    CategoryId,
    CurrencyCode,
    RecipientId,
} from "@vision/types/brands";

export type ReportPeriod =
  | { kind: 'ytd' }
  | { kind: 'rolling'; months: number }
  | { kind: 'custom'; from: string; to: string }
  | { kind: 'year'; year: number };

export interface TaxReportProfile {
  filingStatus?: string;
  region?: string;
  taxYear?: number;
}

export interface TaxReportPITBracket {
  label?: string;
  rate?: number | undefined;
  taxableIncome?: number;
  taxAmount?: number;
}

export interface TaxReportPIT {
  taxableIncome?: number;
  totalTax?: number;
  brackets?: TaxReportPITBracket[];
}

/** Per-partner household result for the tax report (ADR-200/201); amounts only. */
export interface TaxReportHousehold {
  assessmentMode: 'single' | 'separate' | 'joint';
  legalBasis?: string;
  quotient?: {
    applied: boolean;
    transfer: number;
    fromPartnerId?: PartnerId;
    toPartnerId?: PartnerId;
    benefit: number;
  };
  partners: Array<{
    partnerId: PartnerId;
    grossIncome: number;
    taxableIncome: number;
    totalPIT: number;
  }>;
}

export interface ReportOptions {
  currency?: CurrencyCode;
  period?: ReportPeriod;
  sections?: string[];
  theme?: ReportThemeTokens;
  excludedCategoryIds?: CategoryId[];
  excludedRecipientIds?: RecipientId[];
  taxProfile?: TaxReportProfile | undefined;
  precomputedPIT?: TaxReportPIT | undefined;
  /** The year's household, validated by the backend's household settings schema. */
  household?: BelgianTaxHouseholdV2 | undefined;
  precomputedHousehold?: TaxReportHousehold | undefined;
}

/** How a report reached the user: a downloaded PDF or the browser print dialog. */
export type ReportExportResult = 'downloaded' | 'print-dialog';

/**
 * Open the browser print dialog on a report document from a hidden frame. The
 * frame inherits the page's Content Security Policy, which blocks scripts; the
 * report needs none.
 */
function printInBrowser(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    const remove = () => frame.remove();
    frame.addEventListener('load', () => {
      const view = frame.contentWindow;
      if (!view) {
        remove();
        reject(new Error('Report print frame is unavailable'));
        return;
      }
      view.addEventListener('afterprint', remove, { once: true });
      // Browsers without afterprint support still drop the frame eventually.
      setTimeout(remove, 60_000);
      view.focus();
      view.print();
      resolve();
    }, { once: true });
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

async function postReportDownload(
  path: string,
  options: ReportOptions,
): Promise<ReportExportResult> {
  const theme = options.theme ?? resolveActiveThemeTokens();

  const body: Record<string, unknown> = {
    currency: options.currency ?? 'EUR',
    period: options.period ?? { kind: 'rolling', months: 12 },
    sections: options.sections ?? [],
    theme,
    excludedCategoryIds: options.excludedCategoryIds ?? [],
    excludedRecipientIds: options.excludedRecipientIds ?? [],
    ...(options.taxProfile     && { taxProfile:     options.taxProfile     }),
    ...(options.precomputedPIT && { precomputedPIT: options.precomputedPIT }),
    ...(options.household && { household: options.household }),
    ...(options.precomputedHousehold && {
      precomputedHousehold: options.precomputedHousehold,
    }),
  };

  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Report download failed: ${response.status} ${response.statusText}`);
  }

  const report = checkResponseContract<ReportDocument>(
    ReportDocumentSchema,
    unwrapEnvelope<ReportDocument>(await response.json()),
    `POST ${path}`,
  );

  const printer = window.electronReports;
  if (!printer) {
    await printInBrowser(report.html);
    return 'print-dialog';
  }
  const printed = await printer.printToPdf({
    html: report.html,
    footerTemplate: report.footerTemplate,
  });
  if (!printed.success || !printed.pdf) {
    throw new Error(printed.error || 'Report printing failed');
  }
  downloadBlob(
    new Blob([printed.pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
    report.filename,
  );
  return 'downloaded';
}

export function downloadFinancialReport(options: ReportOptions = {}): Promise<ReportExportResult> {
  return postReportDownload('/api/reports/financial', options);
}

export function downloadPortfolioReport(options: ReportOptions = {}): Promise<ReportExportResult> {
  return postReportDownload('/api/reports/portfolio', options);
}

export function downloadTaxReport(options: ReportOptions = {}): Promise<ReportExportResult> {
  return postReportDownload('/api/reports/tax', options);
}
