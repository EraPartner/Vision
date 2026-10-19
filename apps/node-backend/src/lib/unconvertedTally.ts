/**
 * Amounts left out of a total because no stored exchange rate converts them
 * (ADR-216). Server totals never add such an amount 1:1 or at a constant: they
 * leave it out and surface it with the additive `unconverted_count` /
 * `unconverted_currencies` response fields (or the camelCase equivalents in
 * camelCase responses).
 *
 * Pure bookkeeping with no service dependency, so repositories can use it and
 * tests that fake the conversion service still get the real tally.
 */

/**
 * Amounts left out of a total because no stored rate converts them: how many
 * source records (transactions, rows) and which currencies.
 */
export interface UnconvertedTally {
  count: number;
  currencies: Set<string>;
}

/** A row after conversion: `amount_eur` is undefined when no stored rate converts it. */
export interface MaybeConvertedRow {
  currency?: string | null;
  amount_eur: number | undefined;
}

/** A row whose `amount_eur` is known. */
export type WithConvertedAmount<R> = R & { amount_eur: number };

export function createUnconvertedTally(): UnconvertedTally {
  return { count: 0, currencies: new Set() };
}

/** Record `count` left-out records in `currency` (empty means EUR). */
export function noteUnconverted(
  tally: UnconvertedTally,
  currency: string | null | undefined,
  count = 1,
) {
  tally.count += count;
  tally.currencies.add((currency || "EUR").toUpperCase().trim());
}

/**
 * The additive response fields of a tally, named like GET /api/accounts/totals,
 * the planned totals and owes: `unconverted_count` and the sorted
 * `unconverted_currencies`.
 */
export function unconvertedFields(tally: UnconvertedTally) {
  return {
    unconverted_count: tally.count,
    unconverted_currencies: [...tally.currencies].sort(),
  };
}

/**
 * Split rows returned by `convertRowsToEur` into the converted rows and a
 * tally of the rows left out for want of a stored rate. `countOf` gives the
 * number of source records a row stands for (an aggregated row's COUNT(*));
 * it defaults to one.
 */
export function partitionConvertedRows<R extends MaybeConvertedRow>(
  rows: readonly R[],
  countOf: (row: R) => number = () => 1,
  tally: UnconvertedTally = createUnconvertedTally(),
): { converted: WithConvertedAmount<R>[]; unconverted: UnconvertedTally } {
  const converted: WithConvertedAmount<R>[] = [];
  for (const row of rows) {
    if (row.amount_eur === undefined) {
      noteUnconverted(tally, row.currency, countOf(row));
      continue;
    }
    converted.push(row as WithConvertedAmount<R>);
  }
  return { converted, unconverted: tally };
}
