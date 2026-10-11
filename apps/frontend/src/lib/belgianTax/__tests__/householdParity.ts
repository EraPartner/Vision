/**
 * Golden parity harness: runs a v1 profile through `computeBelgianPIT` and through
 * upgrade → `computeHouseholdTax` → `toBelgianTaxCalculation`, and requires both results to be
 * equal field by field (numbers within a relative 1e-9, breakdown labels and order identical).
 *
 * Documented exclusions — cases where the household engine applies a rule the v1 engine does
 * not, so a difference is expected (see ADR-200 and the rule matrix, "Household taxation"):
 *  1. married_joint with other income or alimony: v1 applies the marital quotient to the whole
 *     taxable income; arts 87-88 use professional income only.
 *  2. isSpouseDisabled: v1 adds the spouse's disability supplement to the taxpayer's exemption;
 *     v2 gives it to partner B (art. 131 al. 3). On a single profile there is no partner B, so
 *     v2 grants nothing and `projectHouseholdToProfileV1` reports `isSpouseDisabled: false`
 *     (the v1 flag stays only as an unmapped field); the projection then matches v2, not v1.
 *  3. married_joint with an isolated-parent flag: v1 grants the supplement under a joint
 *     assessment; art. 133 al. 1, 1° requires a taxpayer "die alleen wordt belast".
 *  4. Union dues with the actual method outside employee / civil-servant pay: v2 counts them only
 *     inside a remuneration claim.
 *  5. An exemption balance passed between spouses (art. 134 §1 al. 2, 2011 text): v1 has no
 *     transfer.
 *  6. A quotient towards partner A or dependent supplements allocated to partner B: v1 always
 *     treats A as the earner.
 *  7. A category loss (actual expenses above the income): v1 offsets it against other income.
 *  8. Two partners where the reductions (with the reduction for pensions) exceed a partner's own
 *     tax: v1 caps them at the combined tax.
 *  9. married_joint with a retired earner whose reduction for pensions is limited by art. 153:
 *     v1 takes the tax share from the couple's combined tax, v2 from partner A's own tax
 *     (per spouse, art. 150).
 * Field-level exclusion: when the quotient applies and partner B's own income is below their
 * tax-free sum, `maritalQuotientBenefit` (and its breakdown row amount) differs, because the v2
 * no-quotient baseline includes the art. 134 balance transfer. The tax itself is compared.
 */

import { expect } from "vitest";
import { computeBelgianPIT } from "../pit";
import { getTaxTable } from "../constants";
import { computePensionReduction } from "../personPit";
import { computeHouseholdTax, toBelgianTaxCalculation } from "../household";
import { upgradeProfileV1ToHousehold } from "../householdMigration";
import type { BelgianTaxCalculation, BelgianTaxProfile } from "../types";
import type { HouseholdTaxResult } from "../householdTypes";

export type ParityExclusion =
    | "joint_other_income_or_alimony"
    | "spouse_disabled"
    | "joint_isolated_parent"
    | "union_dues_outside_remuneration"
    | "exemption_balance_transfer"
    | "quotient_or_supplements_towards_other_partner"
    | "category_loss"
    | "reductions_above_partner_tax"
    | "joint_pension_tax_share_limit";

export function parityExclusion(
    profile: BelgianTaxProfile,
    result: HouseholdTaxResult,
): ParityExclusion | undefined {
    const joint = profile.filingStatus === "married_joint";
    if (joint && ((profile.otherTaxableIncome || 0) > 0 || (profile.alimonyPaid || 0) > 0))
        return "joint_other_income_or_alimony";
    if (profile.isSpouseDisabled) return "spouse_disabled";
    if (joint && profile.isIsolatedParent && (profile.dependentChildren || 0) > 0)
        return "joint_isolated_parent";
    if (
        (profile.unionDues || 0) > 0 &&
        profile.professionalExpenseMethod === "actual" &&
        profile.employmentType !== "employee" &&
        profile.employmentType !== "civil_servant"
    )
        return "union_dues_outside_remuneration";
    if (result.partners.some((p) => p.exemption.transferredOut > 0))
        return "exemption_balance_transfer";
    if (
        result.quotient.toPartnerId === "A" ||
        result.partners.some((p) => p.partnerId !== "A" && p.exemption.dependentSupplements > 0)
    )
        return "quotient_or_supplements_towards_other_partner";
    if (result.issues.some((i) => i.code === "loss_offset_not_modelled")) return "category_loss";
    if (
        result.partners.length === 2 &&
        result.partners.some(
            (p) =>
                p.pensionReduction + p.reductions.total + p.ownHomeCredit > p.pitAfterExemption,
        )
    )
        return "reductions_above_partner_tax";
    const a = result.partners.find((p) => p.partnerId === "A");
    if (joint && profile.employmentType === "retired" && a) {
        const pension = computePensionReduction(
            {
                pensionIncome: a.activities
                    .filter((x) => x.kind === "pension")
                    .reduce((acc, x) => acc + x.netProfessionalIncome, 0),
                netIncome: a.netProfessionalIncome + a.otherTaxableIncome,
                taxableIncome: a.taxableIncome,
                taxAfterExemption: a.pitAfterExemption,
            },
            getTaxTable(result.incomeYear),
        );
        if (pension.taxShareLimit < pension.base + pension.additional)
            return "joint_pension_tax_share_limit";
    }
    return undefined;
}

function close(a: number, b: number): boolean {
    if (a === b) return true;
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Deep comparison with numeric tolerance; returns the first differing path. */
export function firstDifference(
    a: unknown,
    b: unknown,
    path = "",
    ignore: ReadonlySet<string> = new Set(),
): string | undefined {
    if (ignore.has(path)) return undefined;
    if (typeof a === "number" && typeof b === "number") {
        return close(a, b) ? undefined : `${path}: ${a} !== ${b}`;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
        for (let i = 0; i < a.length; i++) {
            const d = firstDifference(a[i], b[i], `${path}[${i}]`, ignore);
            if (d) return d;
        }
        return undefined;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of [...keys].sort()) {
            const d = firstDifference(
                (a as Record<string, unknown>)[key],
                (b as Record<string, unknown>)[key],
                path ? `${path}.${key}` : key,
                ignore,
            );
            if (d) return d;
        }
        return undefined;
    }
    return Object.is(a, b) ? undefined : `${path}: ${String(a)} !== ${String(b)}`;
}

export interface ParityOutcome {
    legacy: BelgianTaxCalculation;
    projected: BelgianTaxCalculation;
    household: HouseholdTaxResult;
    exclusion: ParityExclusion | undefined;
    difference: string | undefined;
}

export function compareParity(profile: BelgianTaxProfile): ParityOutcome {
    const legacy = computeBelgianPIT(profile);
    const v2 = upgradeProfileV1ToHousehold(profile);
    const household = computeHouseholdTax(v2);
    const projected = toBelgianTaxCalculation(household, v2);
    const exclusion = parityExclusion(profile, household);
    const ignore = new Set<string>();
    const b = household.partners.find((p) => p.partnerId === "B");
    if (household.quotient.applied && b && b.netProfessionalIncome < b.exemption.ownTotal) {
        ignore.add("maritalQuotientBenefit");
        const row = legacy.breakdown.findIndex((r) => r.label === "Marital quotient tax saving");
        if (row >= 0) ignore.add(`breakdown[${row}].amount`);
    }
    const difference = exclusion ? undefined : firstDifference(legacy, projected, "", ignore);
    return { legacy, projected, household, exclusion, difference };
}

/**
 * Drop-in replacement for `computeBelgianPIT` in tests: returns the v1 result after asserting
 * that the household path reproduces it (unless a documented exclusion applies).
 */
export function computeWithParity(profile: BelgianTaxProfile): BelgianTaxCalculation {
    const outcome = compareParity(profile);
    expect(outcome.difference, "household parity").toBeUndefined();
    return outcome.legacy;
}
