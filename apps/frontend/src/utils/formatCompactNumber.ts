/**
 * Format a number in compact T/B/M notation (e.g. 1_500_000 → "1.50M").
 * Values below 1e6 fall through to `fallback` (default: the plain string).
 * Shared by the research market-data surfaces (SIMP-07).
 */
export function formatCompactNumber(
  val: number | null | undefined,
  fallback: (v: number) => string = (v) => String(v),
): string {
  if (val == null || isNaN(val)) return "—";
  const abs = Math.abs(val);
  if (abs >= 1e12) return `${(val / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
  return fallback(val);
}
