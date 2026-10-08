/**
 * Minimal JSON HTTP GET for research provider adapters (ADR-079).
 *
 * Only fixed, known provider hosts are called (not user-supplied URLs), so there
 * is no SSRF surface here — callers must still URL-encode interpolated symbols.
 * Aborts after a timeout and caps the response body, mirroring the existing
 * price-provider fetch safety.
 */

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * GET a URL and parse JSON. Throws on non-2xx, oversized body, or invalid JSON.
 */
export async function getJson(
  url: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('response exceeded size cap');
  return JSON.parse(text) as unknown;
}

/**
 * Finite-number coercion: returns undefined for null/''/NaN so the UI can blank it.
 */
export function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
