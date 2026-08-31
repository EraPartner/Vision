/**
 * Zod submit schemas for the portfolio Add/Edit transaction dialogs.
 *
 * Both dialogs validate on submit and surface exactly ONE toast for the first
 * failing rule, so each schema is a single transform with early returns — the
 * check order below is the historical toast order and must not be shuffled.
 * Issue messages are i18n keys (see lib/forms/schemas.ts); the dialogs
 * translate `issues[0].message` into the same `toast.error` as before.
 *
 * The two modes deliberately differ (long-standing behavior, kept verbatim):
 * - Add parses the amount with `parsePositive` (0/negative → "missing"),
 *   derives only for buy/sell, and maps empty fees/taxes/FX to `undefined`
 *   (omitted from the POST body).
 * - Edit parses the amount with `parseNonNegative`, additionally rejects a
 *   non-gift amount ≤ 0, requires a date, derives for buy/sell AND gift, and
 *   maps cleared fees/taxes to 0 and cleared FX to explicit `null` — cleared
 *   fields must be SENT so the PATCH actually clears them (see the payload
 *   comments in EditPortfolioTxnDialog).
 * - The fees/taxes/fx-rate garbage guards (NaN fallback so bad input can't
 *   silently post €0, FX must be > 0) encode the 20481c8 fix in both modes.
 */
import { z } from "zod";
import { parseDecimal } from "@/lib/decimal";
import { deriveUnitMath, parsePositive } from "@/lib/portfolioUnitMath";

/**
 * Parse a form-field string as a non-negative number (Edit's amount parser —
 * unlike parsePositive, an explicit 0 stays 0). Empty/garbage/negative →
 * undefined.
 */
export function parseNonNegative(value: string): number | undefined {
    if (!value.trim()) return undefined;
    const n = parseDecimal(value, NaN);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
}

/** Per-submit facts the dialogs already derive from the transaction type. */
export interface PortfolioTxnFlags {
    isBuySell: boolean;
    isGift: boolean;
}

/**
 * The fees/taxes garbage guard both schemas apply to a NON-EMPTY field (empty
 * means "omitted" on Add and "cleared to 0" on Edit — never an error). Exported
 * so the dialogs' render-time inline field errors use the exact predicate the
 * submit gate runs, and the two can never disagree.
 */
export function invalidOptionalMoney(value: string): boolean {
    if (!value) return false;
    const n = parseDecimal(value, NaN);
    return !Number.isFinite(n) || n < 0;
}

/** Same, for the FX rate: a typed value must be strictly positive. */
export function invalidOptionalFxRate(value: string): boolean {
    if (!value) return false;
    const n = parseDecimal(value, NaN);
    return !Number.isFinite(n) || n <= 0;
}

const rawFields = z.object({
    date: z.string(),
    amount: z.string(),
    units: z.string(),
    pricePerUnit: z.string(),
    fees: z.string(),
    taxes: z.string(),
    fxRateToEur: z.string(),
});

type IssueCtx = {
    addIssue: (issue: {
        code: typeof z.ZodIssueCode.custom;
        message: string;
    }) => void;
};

function fail(ctx: IssueCtx, message: string): typeof z.NEVER {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    return z.NEVER;
}

/** Values AddPortfolioTxnDialog posts (undefined keys are omitted from JSON). */
export interface AddPortfolioTxnParsed {
    date: string;
    amount: number;
    units?: number;
    pricePerUnit?: number;
    fees?: number;
    taxes?: number;
    fxRateToEur?: number;
}

export function addPortfolioTxnSchema({
    isBuySell,
    isGift,
}: PortfolioTxnFlags) {
    return rawFields.transform((raw, ctx): AddPortfolioTxnParsed => {
        const unitMath = deriveUnitMath({
            amount: parsePositive(raw.amount),
            units: parsePositive(raw.units),
            price: parsePositive(raw.pricePerUnit),
            derive: isBuySell,
        });
        const effectiveAmount = isGift ? 0 : unitMath.effectiveAmount;
        const { effectiveUnits, effectivePrice } = unitMath;

        if (isBuySell && !unitMath.isConsistent) {
            return fail(ctx, "addPortTxn.error.twoOfThreeRequired");
        }
        if (
            !isGift &&
            (effectiveAmount === undefined || Number.isNaN(effectiveAmount))
        ) {
            return fail(ctx, "addPortTxn.error.amountRequired");
        }
        if (isGift && effectiveUnits === undefined) {
            return fail(ctx, "addPortTxn.error.unitsRequired");
        }

        // NaN fallback, not the default 0 — garbage in these fields must block the
        // submit instead of silently posting €0 fees/taxes or fx_rate_to_eur = 0.
        const fees = raw.fees ? parseDecimal(raw.fees, NaN) : undefined;
        const taxes = raw.taxes ? parseDecimal(raw.taxes, NaN) : undefined;
        const fxRateToEur = raw.fxRateToEur
            ? parseDecimal(raw.fxRateToEur, NaN)
            : undefined;
        if (
            invalidOptionalMoney(raw.fees) ||
            invalidOptionalMoney(raw.taxes) ||
            invalidOptionalFxRate(raw.fxRateToEur)
        ) {
            return fail(ctx, "addPortTxn.error.invalidNumber");
        }

        return {
            date: raw.date,
            amount: effectiveAmount as number,
            units: effectiveUnits,
            pricePerUnit: effectivePrice,
            fees: isGift ? 0 : fees,
            taxes: isGift ? 0 : taxes,
            fxRateToEur,
        };
    });
}

/** Values EditPortfolioTxnDialog PATCHes (null = "clear on the backend"). */
export interface EditPortfolioTxnParsed {
    date: string;
    /** May be undefined for a gift (amount is editable but not required there). */
    amount?: number;
    units?: number;
    pricePerUnit?: number;
    fees: number;
    taxes: number;
    fxRateToEur: number | null;
}

export function editPortfolioTxnSchema({
    isBuySell,
    isGift,
}: PortfolioTxnFlags) {
    return rawFields.transform((raw, ctx): EditPortfolioTxnParsed => {
        const unitMath = deriveUnitMath({
            amount: parseNonNegative(raw.amount),
            units: parsePositive(raw.units),
            price: parsePositive(raw.pricePerUnit),
            derive: isBuySell || isGift,
        });
        const { effectiveAmount, effectiveUnits, effectivePrice } = unitMath;

        if (isBuySell && !unitMath.isConsistent) {
            return fail(ctx, "addPortTxn.error.twoOfThreeRequired");
        }
        if (
            !isGift &&
            (effectiveAmount === undefined ||
                Number.isNaN(effectiveAmount) ||
                effectiveAmount <= 0)
        ) {
            return fail(ctx, "addPortTxn.error.amountRequired");
        }
        if (isGift && effectiveUnits === undefined) {
            return fail(ctx, "addPortTxn.error.unitsRequired");
        }
        if (!raw.date) {
            return fail(ctx, "addPortTxn.error.dateRequired");
        }

        // Same guard as the Add dialog: NaN fallback so garbage can't silently
        // become €0, and an FX rate of 0 (min="0" permits it) must not reach the
        // backend's "must be positive" check as a raw 400.
        const fees = raw.fees ? parseDecimal(raw.fees, NaN) : 0;
        const taxes = raw.taxes ? parseDecimal(raw.taxes, NaN) : 0;
        const fxRateToEur = raw.fxRateToEur
            ? parseDecimal(raw.fxRateToEur, NaN)
            : null;
        if (
            invalidOptionalMoney(raw.fees) ||
            invalidOptionalMoney(raw.taxes) ||
            invalidOptionalFxRate(raw.fxRateToEur)
        ) {
            return fail(ctx, "addPortTxn.error.invalidNumber");
        }

        return {
            date: raw.date,
            amount: effectiveAmount,
            units: effectiveUnits,
            pricePerUnit: effectivePrice,
            fees: isGift ? 0 : fees,
            taxes: isGift ? 0 : taxes,
            fxRateToEur,
        };
    });
}
