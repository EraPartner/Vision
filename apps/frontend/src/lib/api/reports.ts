/**
 * Report API — file download helpers.
 *
 * These functions trigger a browser download by fetching the report as a Blob
 * and creating a temporary anchor element. No `apiRequest` wrapper is used
 * because the response is a binary stream, not a JSON envelope.
 */

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function downloadBlob(url: string, filename: string): Promise<void> {
  const response = await fetch(url, { credentials: 'same-origin' });
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

export async function downloadFinancialReport(params?: {
  currency?: string;
}): Promise<void> {
  const url = buildUrl('/api/reports/financial', { currency: params?.currency });
  const filename = `financial-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  await downloadBlob(url, filename);
}
