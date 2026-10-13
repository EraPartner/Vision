/** Decimal places each derived field is rounded to (matches the backend normalizer). */
export const UNIT_MATH_AMOUNT_DP = 4;
export const UNIT_MATH_UNITS_DP = 8;
export const UNIT_MATH_PRICE_DP = 6;

/**
 * Tolerance for the amount ≈ units × price consistency check. Must match the
 * backend's 0.01 (portfolioTxRepo.common.js) — a stricter frontend hard-blocked
 * legitimately cent-off broker statements (3 × €33.33 vs €100.00) that the
 * backend tolerance exists to accept.
 */
export const UNIT_MATH_TOLERANCE = 0.01;

/** Float round to `decimals` places (UI validation only). */
export function roundUnitMath(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export interface UnitMathInput {
  amount?: number | undefined;
  units?: number | undefined;
  price?: number | undefined;
  /** When false, skip derivation and consistency (effective = inputs as-is). Default true. */
  derive?: boolean | undefined;
}

export interface UnitMathResult {
  /** The field that was computed because it was omitted (undefined if it was provided). */
  derivedAmount?: number | undefined;
  derivedUnits?: number | undefined;
  derivedPrice?: number | undefined;
  /** input value if provided, otherwise the derived value. */
  effectiveAmount?: number | undefined;
  effectiveUnits?: number | undefined;
  effectivePrice?: number | undefined;
  /** How many of amount/units/price were provided. */
  providedCount: number;
  /** True when ≥2 provided and amount ≈ units × price within tolerance. */
  isConsistent: boolean;
}

/**
 * Given any two of amount / units / price, derive the third; report whether the
 * three are mutually consistent.
 */
export function deriveUnitMath({
  amount,
  units,
  price,
  derive = true,
}: UnitMathInput): UnitMathResult {
  const providedCount =
    Number(amount !== undefined) +
    Number(units !== undefined) +
    Number(price !== undefined);

  let derivedAmount: number | undefined;
  let derivedUnits: number | undefined;
  let derivedPrice: number | undefined;

  if (derive && providedCount >= 2) {
    if (amount === undefined && units !== undefined && price !== undefined) {
      derivedAmount = roundUnitMath(units * price, UNIT_MATH_AMOUNT_DP);
    }
    if (units === undefined && amount !== undefined && price !== undefined) {
      derivedUnits = roundUnitMath(amount / price, UNIT_MATH_UNITS_DP);
    }
    if (price === undefined && amount !== undefined && units !== undefined) {
      derivedPrice = roundUnitMath(amount / units, UNIT_MATH_PRICE_DP);
    }
  }

  const effectiveAmount = amount ?? derivedAmount;
  const effectiveUnits = units ?? derivedUnits;
  const effectivePrice = price ?? derivedPrice;

  const isConsistent =
    derive &&
    providedCount >= 2 &&
    effectiveAmount !== undefined &&
    effectiveUnits !== undefined &&
    effectivePrice !== undefined &&
    // Round the difference before comparing — float subtraction at the exact
    // boundary yields e.g. 0.010000000000005 > 0.01, wrongly rejecting the
    // one-cent case (the backend compares with Decimal for the same reason).
    roundUnitMath(
      Math.abs(
        roundUnitMath(effectiveUnits * effectivePrice, UNIT_MATH_AMOUNT_DP) -
          roundUnitMath(effectiveAmount, UNIT_MATH_AMOUNT_DP),
      ),
      UNIT_MATH_AMOUNT_DP,
    ) <= UNIT_MATH_TOLERANCE;

  return {
    derivedAmount,
    derivedUnits,
    derivedPrice,
    effectiveAmount,
    effectiveUnits,
    effectivePrice,
    providedCount,
    isConsistent,
  };
}
