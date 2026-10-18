/**
 * Marital quotient (huwelijksquotiënt) of WIB 92 arts 87-88 for a jointly assessed household.
 *
 *  - Art. 87: when only one spouse has professional income, 30% of it is attributed to the other,
 *    capped.
 *  - Art. 88 al. 1: when one spouse's professional income is below 30% of the couple's total,
 *    that spouse is attributed the part that brings own income PLUS the attributed part to 30%
 *    of the total, "doch niet hoger dan" the cap (the cap bounds the sum).
 *  - Art. 88 al. 2 / art. 87: not applied when it raises the tax.
 *  - From AY 2027 the cap is higher when both spouses have reached 66 on 1 January of the
 *    assessment year (law of 15 July 2026 arts 27 and 30, A).
 * The quotient works on net professional income only (arts 87-88 "beroepsinkomsten"); other
 * income and deductions do not enter the 30% computation.
 * Matrix rows: "Marital quotient and joint assessment".
 */

import type { BelgianTaxYearTable } from "./constants.ts";
import type {
    HouseholdTaxIssue,
    MaritalQuotientResult,
    PartnerId,
} from "./householdTypes.ts";

export interface QuotientPartnerInput {
    id: PartnerId;
    netProfessionalIncome: number;
    birthYear?: number;
}

export interface MaritalQuotientCap {
    cap: number;
    bothSenior: boolean;
    issues: HouseholdTaxIssue[];
}

/**
 * Cap for the income year. The senior cap applies when both spouses have reached 66 on 1 January
 * of the assessment year (income year + 1). With a birth year only, a spouse born in
 * `incomeYear − 66` or earlier qualifies; a spouse born on 1 January of the next year (who turns
 * 66 exactly on that date) is not recognised.
 */
export function resolveMaritalQuotientCap(
    partners: readonly QuotientPartnerInput[],
    incomeYear: number,
    table: BelgianTaxYearTable,
): MaritalQuotientCap {
    const seniorCap = table.maritalQuotientCapBothSenior;
    if (seniorCap === undefined) {
        return { cap: table.maritalQuotientCap, bothSenior: false, issues: [] };
    }
    if (partners.some((p) => p.birthYear === undefined)) {
        return {
            cap: table.maritalQuotientCap,
            bothSenior: false,
            issues: [{ code: "senior_quotient_cap_birth_years_missing", severity: "info" }],
        };
    }
    const bothSenior =
        partners.length === 2 &&
        partners.every((p) => (p.birthYear as number) <= incomeYear - 66);
    return {
        cap: bothSenior ? seniorCap : table.maritalQuotientCap,
        bothSenior,
        issues: [],
    };
}

export interface QuotientTransfer {
    from: PartnerId;
    to: PartnerId;
    transfer: number;
}

export interface ComputeMaritalQuotientInput {
    partners: readonly [QuotientPartnerInput, QuotientPartnerInput];
    rate: number;
    cap: number;
    /**
     * Combined tax of both partners for a given transfer (undefined = no quotient). The quotient
     * is applied only when it returns a strictly lower value than the baseline.
     */
    evaluate: (transfer: QuotientTransfer | undefined) => number;
}

export function computeMaritalQuotient(
    input: ComputeMaritalQuotientInput,
): MaritalQuotientResult {
    const { partners, rate, cap, evaluate } = input;
    const [p0, p1] = partners;
    const income0 = Math.max(p0.netProfessionalIncome, 0);
    const income1 = Math.max(p1.netProfessionalIncome, 0);
    const household = income0 + income1;
    const notApplied: MaritalQuotientResult = {
        applied: false,
        transfer: 0,
        target: 0,
        cap,
        benefit: 0,
    };
    if (household <= 0) return notApplied;

    // The receiver is the spouse with the lower professional income; a tie never qualifies.
    const [giver, receiver, receiverIncome] =
        income0 >= income1 ? [p0, p1, income1] : [p1, p0, income0];
    const target = Math.min(household * rate, cap);
    const transfer = Math.max(0, target - receiverIncome);
    if (transfer <= 0) return { ...notApplied, target };

    const baseline = evaluate(undefined);
    const withQuotient = evaluate({ from: giver.id, to: receiver.id, transfer });
    if (withQuotient >= baseline) return { ...notApplied, target };
    return {
        applied: true,
        transfer,
        fromPartnerId: giver.id,
        toPartnerId: receiver.id,
        target,
        cap,
        benefit: baseline - withQuotient,
    };
}
