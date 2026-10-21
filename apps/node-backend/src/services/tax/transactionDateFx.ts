import { getHistoricalRateIndex } from "../currency/currencyConversionService.ts";
import { findRateOnOrBeforeInIndex } from "../currency/rateFetcher.ts";
import { toDecimal } from "../../lib/money.ts";

/** The fields of a portfolio transaction that tax figures convert. */
interface DatedAmounts {
  date?: string | undefined;
  currency?: string | null | undefined;
  fx_rate_to_eur?: number | string | null | undefined;
  amount?: number | null | undefined;
  taxes?: number | null | undefined;
  fees?: number | null | undefined;
}

/**
 * Restate each transaction's amount, taxes and fees in `target` at the rate of
 * the transaction's own date (ADR-085, ADR-240): the rate stamped on the row
 * (`fx_rate_to_eur`), else the stored rate on or before its date. A closed
 * tax year's TOB, withholding tax and fees then no longer move with today's
 * rate. A row whose dated rate cannot be resolved keeps its own currency, so
 * the caller's latest-rate converter converts it or flags it as unconverted.
 */
export async function restateAtTransactionDateRates<T extends DatedAmounts>(
  txns: readonly T[],
  target: string,
): Promise<T[]> {
  const to = target.toUpperCase();
  const currencyOf = (txn: T) => (txn.currency || "EUR").toUpperCase();
  const foreign = txns.filter((txn) => currencyOf(txn) !== to);
  if (foreign.length === 0) return [...txns];
  const index = await getHistoricalRateIndex(
    [...new Set([...foreign.map(currencyOf), to])].filter((c) => c !== "EUR"),
  );
  return txns.map((txn) => {
    const from = currencyOf(txn);
    if (from === to || !txn.date) return txn;
    const date = txn.date.slice(0, 10);
    const stamped = Number(txn.fx_rate_to_eur);
    const rateFrom =
      from === "EUR"
        ? 1
        : Number.isFinite(stamped) && stamped > 0
          ? stamped
          : findRateOnOrBeforeInIndex(index, from, date);
    const rateTo =
      to === "EUR" ? 1 : findRateOnOrBeforeInIndex(index, to, date);
    if (rateFrom === undefined || rateTo === undefined || !(rateTo > 0))
      return txn;
    const multiplier = toDecimal(rateFrom).div(rateTo);
    const restate = (value: number | null | undefined) =>
      value == null ? value : toDecimal(value).times(multiplier).toNumber();
    // Same row with its money fields in the target currency (a currency code).
    const restated: T = {
      ...txn,
      amount: restate(txn.amount),
      taxes: restate(txn.taxes),
      fees: restate(txn.fees),
      currency: to,
    };
    return restated;
  });
}
