/**
 * Whether a conversion can be represented in the requested target currency
 * without a synthetic 1:1 or wrong-target fallback.
 *
 * Same-currency values never need a rate. EUR is the rate table's base and is
 * therefore implicitly available even when a caller supplies a sparse fixture.
 */
export function hasConversionRate(
  fromCurrency: string | null | undefined,
  toCurrency: string | null | undefined,
  rates: Record<string, number>,
): boolean {
  const from = (fromCurrency || "EUR").toUpperCase().trim();
  const to = (toCurrency || "EUR").toUpperCase().trim();
  if (from === to) return true;
  const hasFrom = from === "EUR" || Boolean(rates[from]);
  const hasTo = to === "EUR" || Boolean(rates[to]);
  return hasFrom && hasTo;
}
