import { formatPercent } from "@/utils/currency";

/**
 * Signed percent label for delta chips (e.g. "+3,20%", "-1,05%").
 * Shared by the portfolio holdings pages, which previously each carried a
 * local copy.
 *
 * Delegates to the shared `formatPercent` so the decimal separator follows the
 * app's number-format setting like the money beside it, instead of the dot
 * `toFixed` always emitted. 2dp is kept: these are market-quote day moves,
 * where 2dp is the domain convention.
 */
export function fmtPct(val: number): string {
  return formatPercent(val, { digits: 2, signed: true });
}
