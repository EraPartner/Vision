/**
 * Shared "derive the missing one of amount / units / price" math for the
 * portfolio Add/Edit transaction dialogs.
 *
 * Previously copy-pasted verbatim in AddPortfolioTxnDialog and
 * EditPortfolioTxnDialog (same precisions + tolerance); drift between the two
 * meant Add and Edit could silently accept/reject different inputs. One pure,
 * unit-tested helper keeps them in lock-step.
 */

/** Decimal places each derived field is rounded to (matches the backend normalizer). */
export const UNIT_MATH_AMOUNT_DP = 4;
export const UNIT_MATH_UNITS_DP = 8;
export const UNIT_MATH_PRICE_DP = 6;

/** Tolerance for the amount ≈ units × price consistency check. */
export const UNIT_MATH_TOLERANCE = 0.0001;

/** Float round to `decimals` places (UI validation only). */
export function roundUnitMath(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export interface UnitMathInput {
  amount?: number;
  units?: number;
  price?: number;
  /** When false, skip derivation and consistency (effective = inputs as-is). Default true. */
  derive?: boolean;
}

export interface UnitMathResult {
  /** The field that was computed because it was omitted (undefined if it was provided). */
  derivedAmount?: number;
  derivedUnits?: number;
  derivedPrice?: number;
  /** input value if provided, otherwise the derived value. */
  effectiveAmount?: number;
  effectiveUnits?: number;
  effectivePrice?: number;
  /** How many of amount/units/price were provided. */
  providedCount: number;
  /** True when ≥2 provided and amount ≈ units × price within tolerance. */
  isConsistent: boolean;
}

/**
 * Given any two of amount / units / price, derive the third; report whether the
 * three are mutually consistent.
 */
export function deriveUnitMath({ amount, units, price, derive = true }: UnitMathInput): UnitMathResult {
  const providedCount =
    Number(amount !== undefined) + Number(units !== undefined) + Number(price !== undefined);

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
    Math.abs(
      roundUnitMath(effectiveUnits * effectivePrice, UNIT_MATH_AMOUNT_DP) -
        roundUnitMath(effectiveAmount, UNIT_MATH_AMOUNT_DP),
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
