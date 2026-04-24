/**
 * Report API — PDF download helpers.
 *
 * All three report types use POST so the frontend can forward resolved CSS
 * theme tokens, period selection, and section flags in the request body.
 * The response is a binary PDF stream; no JSON envelope wrapper is used.
 */

import { resolveActiveThemeTokens, type ReportThemeTokens } from '@/lib/themeTokens';

export type PeriodKind = 'ytd' | 'rolling' | 'custom' | 'year';

export type ReportPeriod =
  | { kind: 'ytd' }
  | { kind: 'rolling'; months: number }
  | { kind: 'custom'; from: string; to: string }
  | { kind: 'year'; year: number };

export interface ReportOptions {
  currency?: string;
  period?: ReportPeriod;
  sections?: string[];
  theme?: ReportThemeTokens;
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
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function reportFilename(type: string): string {
  return `vision-${type}-${new Date().toISOString().slice(0, 10)}.pdf`;
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
