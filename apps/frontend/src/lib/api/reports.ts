/**
 * Report API — PDF download helpers.
 *
 * All three report types use POST so the frontend can forward resolved CSS
 * theme tokens, period selection, and section flags in the request body.
 * The response is a binary PDF stream; no JSON envelope wrapper is used.
 */

import { resolveActiveThemeTokens, type ReportThemeTokens } from '@/lib/themeTokens';
import { downloadBlob } from '@/lib/downloadBlob';
import { todayYmd } from '@/lib/timezone';

export type PeriodKind = 'ytd' | 'rolling' | 'custom' | 'year';

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
  rate?: number;
  taxableIncome?: number;
  taxAmount?: number;
}

export interface TaxReportPIT {
  taxableIncome?: number;
  totalTax?: number;
  brackets?: TaxReportPITBracket[];
}

export interface ReportOptions {
  currency?: string;
  period?: ReportPeriod;
  sections?: string[];
  theme?: ReportThemeTokens;
  excludedCategoryIds?: number[];
  excludedRecipientIds?: number[];
  taxProfile?: TaxReportProfile;
  precomputedPIT?: TaxReportPIT;
}

async function postReportDownload(
  path: string,
  options: ReportOptions,
  filename: string,
): Promise<void> {
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

  const blob = await response.blob();
  downloadBlob(blob, filename);
}

function reportFilename(type: string): string {
  return `vision-${type}-${todayYmd()}.pdf`;
}

export async function downloadFinancialReport(options: ReportOptions = {}): Promise<void> {
  await postReportDownload('/api/reports/financial', options, reportFilename('financial'));
}

export async function downloadPortfolioReport(options: ReportOptions = {}): Promise<void> {
  await postReportDownload('/api/reports/portfolio', options, reportFilename('portfolio'));
}

export async function downloadTaxReport(options: ReportOptions = {}): Promise<void> {
  await postReportDownload('/api/reports/tax', options, reportFilename('tax'));
}
