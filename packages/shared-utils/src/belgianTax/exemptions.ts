/**
 * Tax-free sum (belastingvrije som) of WIB 92 arts 131-134: dependent supplements and their
 * allocation between partners. Rule rows: docs/reference/belgian-tax-rule-matrix.md,
 * "Progressive tax and exemptions" and "Household taxation".
 */

import type { BelgianTaxYearTable } from "./constants.ts";
import type {
    AssessmentMode,
    ExemptionAllocation,
    HouseholdDependents,
    HouseholdTaxIssue,
    PartnerId,
} from "./householdTypes.ts";
import { orZero } from "../numeric.ts";

export interface DependentSupplements {
    /** Effective child count on the art. 132 scale (disabled children count twice). */
    childCount: number;
    /** Art. 132 al. 1, 1°-5° supplement for the effective child count. */
    children: number;
    /** Art. 132 al. 1, 6°: child under 3, forfeited when childcare is deducted. */
    childUnder3: number;
    /** Art. 132 al. 1, 8°: other dependants (disabled count twice). */
    otherDependents: number;
    total: number;
}

/**
 * Supplements of art. 132 for the household's dependants. Handicapped dependants count for TWO
 * on the supplement scale (art. 132 al. 2), so the effective count is bumped by the disabled
 * subset. The child-under-3 supplement cannot be combined with the childcare reduction
 * (art. 132 al. 1, 6°).
 */
export function computeDependentSupplements(
    dependents: Pick<
        HouseholdDependents,
        "children" | "childrenUnder3" | "childrenDisabled" | "otherPersons" | "otherPersonsDisabled"
    >,
    childcareDeducted: boolean,
    table: BelgianTaxYearTable,
): DependentSupplements {
    const rawChildren = Math.max(orZero(dependents.children), 0);
    const disabledChildren = Math.min(
        Math.max(orZero(dependents.childrenDisabled), 0),
        rawChildren,
    );
    const childCount = rawChildren + disabledChildren;

    const children =
        childCount <= 4
            ? (table.dependentChildExemptionIncreases[childCount] ?? 0)
            : (table.dependentChildExemptionIncreases[4] ?? 0) +
              (childCount - 4) * table.extraChildExemptionFromFifth;

    const childUnder3 = childcareDeducted
        ? 0
        : Math.max(orZero(dependents.childrenUnder3), 0) *
          table.childUnder3Supplement;

    const rawOtherDep = Math.max(orZero(dependents.otherPersons), 0);
    const disabledOther = Math.min(
        Math.max(orZero(dependents.otherPersonsDisabled), 0),
        rawOtherDep,
    );
    const otherDependents =
        (rawOtherDep + disabledOther) * table.otherDependentExemption;

    return {
        childCount,
        children,
        childUnder3,
        otherDependents,
        total: children + childUnder3 + otherDependents,
    };
}

/**
 * Partner who claims the dependants outside a joint assessment: `claimantPartnerId` when that
 * partner is assessed, else the first assessed partner (A when present). Undefined only when no
 * partner is assessed.
 */
export function resolveDependentsClaimant(
    partners: readonly { id: PartnerId }[],
    claimantPartnerId: PartnerId | undefined,
): PartnerId | undefined {
    return claimantPartnerId !== undefined && partners.some((p) => p.id === claimantPartnerId)
        ? claimantPartnerId
        : partners[0]?.id;
}

export interface ExemptionPartnerInput {
    id: PartnerId;
    isDisabled: boolean;
    isIsolatedParent?: boolean;
    /** Taxable income after the marital quotient. */
    taxableIncome: number;
}

export interface AllocateExemptionsInput {
    mode: AssessmentMode;
    partners: ExemptionPartnerInput[];
    dependents: HouseholdDependents;
    childcareDeducted: boolean;
    table: BelgianTaxYearTable;
}

export interface AllocateExemptionsResult {
    allocations: Partial<Record<PartnerId, ExemptionAllocation>>;
    /** Partner who received the art. 132 dependent supplements. */
    supplementPartnerId: PartnerId;
    supplements: DependentSupplements;
    /** Exemption left unapplied after all transfers (sum over partners). */
    unusedExemption: number;
    issues: HouseholdTaxIssue[];
}

/**
 * Allocate the tax-free sum between partners.
 *
 *  - Every partner gets the basic amount (art. 131 al. 1) plus their own disability supplement
 *    (art. 131 al. 3 in the 2011 text: "indien de belastingplichtige gehandicapt is").
 *  - Joint assessment: the art. 132 supplements go to the partner with the highest taxable
 *    income (art. 134 §1 al. 2, 2011 text), taken after the marital quotient because art. 127,
 *    1° sets each spouse's income "na toepassing van de artikelen 86 tot 89". When one partner's
 *    taxable income is lower than their tax-free sum, the balance is added to the other partner's
 *    tax-free sum (same paragraph).
 *  - Otherwise the supplements go to `claimantPartnerId` (default A).
 *  - Isolated-parent supplement (art. 133 al. 1, 1°: "een belastingplichtige die alleen wordt
 *    belast"): granted only to a partner assessed alone without a co-assessed partner. Under a
 *    joint assessment it is refused (warning); under a separate assessment of two partners it is
 *    refused pending a source on cohabitation (needs_source, L2 art. 9 adds a household test).
 */
export function allocateExemptions(
    input: AllocateExemptionsInput,
): AllocateExemptionsResult {
    const { mode, partners, dependents, childcareDeducted, table } = input;
    const issues: HouseholdTaxIssue[] = [];
    const supplements = computeDependentSupplements(
        dependents,
        childcareDeducted,
        table,
    );
    const claimant: PartnerId =
        resolveDependentsClaimant(partners, dependents.claimantPartnerId) ?? "A";

    let supplementPartnerId: PartnerId = claimant;
    if (mode === "joint" && partners.length === 2) {
        const [p0, p1] = partners as [ExemptionPartnerInput, ExemptionPartnerInput];
        if (p0.taxableIncome > p1.taxableIncome) supplementPartnerId = p0.id;
        else if (p1.taxableIncome > p0.taxableIncome) supplementPartnerId = p1.id;
    }

    const coAssessed = partners.length === 2;
    const allocations: Partial<Record<PartnerId, ExemptionAllocation>> = {};
    for (const p of partners) {
        const basic = table.basicPersonalExemption;
        const dependentSupplements =
            p.id === supplementPartnerId ? supplements.total : 0;
        const disability = p.isDisabled ? table.disabledSupplement : 0;
        let isolatedParentSupplement = 0;
        if (p.isIsolatedParent && supplements.childCount > 0) {
            if (!coAssessed && mode === "single") {
                isolatedParentSupplement = table.isolatedParentSupplement;
            } else {
                issues.push({
                    code: "isolated_parent_supplement_not_granted",
                    severity: mode === "joint" ? "warning" : "needs_source",
                    partnerId: p.id,
                });
            }
        }
        // Summation order matches the single-profile engine so one-partner results are equal.
        const ownTotal =
            basic +
            (p.id === supplementPartnerId ? supplements.children : 0) +
            (p.id === supplementPartnerId ? supplements.childUnder3 : 0) +
            (p.id === supplementPartnerId ? supplements.otherDependents : 0) +
            disability +
            isolatedParentSupplement;
        allocations[p.id] = {
            basic,
            disability,
            dependentSupplements,
            isolatedParentSupplement,
            ownTotal,
            transferredIn: 0,
            transferredOut: 0,
            total: ownTotal,
            applied: Math.min(ownTotal, Math.max(p.taxableIncome, 0)),
        };
    }

    if (mode === "joint" && partners.length === 2) {
        const [p0, p1] = partners as [ExemptionPartnerInput, ExemptionPartnerInput];
        const a0 = allocations[p0.id] as ExemptionAllocation;
        const a1 = allocations[p1.id] as ExemptionAllocation;
        const short0 = Math.max(p0.taxableIncome, 0) < a0.ownTotal;
        const short1 = Math.max(p1.taxableIncome, 0) < a1.ownTotal;
        // Only one partner can pass a balance on usefully; when both are short nothing changes.
        if (short0 !== short1) {
            const [giver, gA, receiver, rA] = short0
                ? [p0, a0, p1, a1]
                : [p1, a1, p0, a0];
            const balance = gA.ownTotal - Math.max(giver.taxableIncome, 0);
            gA.transferredOut = balance;
            gA.total = gA.ownTotal - balance;
            gA.applied = Math.min(gA.total, Math.max(giver.taxableIncome, 0));
            rA.transferredIn = balance;
            rA.total = rA.ownTotal + balance;
            rA.applied = Math.min(rA.total, Math.max(receiver.taxableIncome, 0));
        }
    }

    let unusedExemption = 0;
    for (const p of partners) {
        const a = allocations[p.id] as ExemptionAllocation;
        unusedExemption += a.total - a.applied;
    }

    return { allocations, supplementPartnerId, supplements, unusedExemption, issues };
}
