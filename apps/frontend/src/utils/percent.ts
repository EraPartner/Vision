/**
 * Signed fixed-2 percent label for delta chips (e.g. "+3.20%", "-1.05%").
 * Shared by the portfolio holdings pages, which previously each carried a
 * local copy.
 */
export function fmtPct(val: number): string {
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
}
