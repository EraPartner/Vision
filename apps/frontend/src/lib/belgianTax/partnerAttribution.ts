/**
 * Belgian tax — attribution of transaction-derived figures to the partners of a household
 * (ADR-201, superseding ADR-200 §7 for the mapping).
 *
 * The mapping is fixed: account owner `me` is partner A, `partner` is partner B and `joint`
 * accounts are split 50/50. A transaction without an account counts as `me`. Without partner B
 * every amount goes to partner A unchanged, so a single-person household keeps its figures.
 *
 * Kept out of the `@/lib/belgianTax` barrel: import it by file path.
 */

import { applyProfileV1PatchToHousehold } from "./householdMigration";
import type { DeductionFieldMapping } from "./deductionCandidateFields";
import type {
    BelgianTaxHouseholdV2,
    HouseholdPartner,
    PartnerId,
} from "./householdTypes";

/** `accounts.owner` values. */
export type AccountOwner = "me" | "partner" | "joint";

/** Amounts per account owner; a missing owner counts as 0. */
export type OwnerAmounts = Partial<Record<AccountOwner, number>>;

/** Amounts per partner; `B` is 0 when the household has no partner B. */
export type PartnerAmounts = Record<PartnerId, number>;

const cents = (value: number) => Math.round(value * 100) / 100;

export function householdHasPartnerB(
    household: Pick<BelgianTaxHouseholdV2, "partners"> | null | undefined,
): boolean {
    return household?.partners.some((p) => p.id === "B") ?? false;
}

/**
 * Partner B's share of the owner amounts: the `partner` amount plus half of the `joint` one,
 * rounded to cents. 0 without partner B.
 */
export function partnerBShare(byOwner: OwnerAmounts | undefined, hasPartnerB: boolean): number {
    if (!hasPartnerB || !byOwner) return 0;
    return cents((byOwner.partner ?? 0) + (byOwner.joint ?? 0) / 2);
}

/**
 * Split `total` between the partners. Partner A receives the total minus partner B's share, so
 * the two shares always add up to `total`; without partner B, A receives `total` unchanged.
 */
export function attributeToPartners(
    total: number,
    byOwner: OwnerAmounts | undefined,
    hasPartnerB: boolean,
): PartnerAmounts {
    const b = partnerBShare(byOwner, hasPartnerB);
    if (b === 0) return { A: total, B: 0 };
    return { A: cents(total - b), B: b };
}

/** The activity that receives a partner's recorded income: the first one with a gross figure. */
function grossActivity(partner: HouseholdPartner) {
    return partner.activities.find((a) => a.kind !== "net_professional_amount");
}

/**
 * Household whose partners earn the recorded income `total`, of which `partnerB` belongs to
 * partner B, for a what-if estimate (the yearly chart and the monthly reserve). Partner A's share
 * goes to A's primary activity exactly as a v1 `grossAnnualIncome` patch would, and B's share
 * replaces the gross of B's first activity that carries a gross figure. Returns `undefined` when
 * B has no such activity (for example a migrated spouse with only a net amount): the caller then
 * keeps the whole total on partner A, as before attribution existed.
 */
export function householdWithRecordedIncome(
    household: BelgianTaxHouseholdV2,
    total: number,
    partnerB: number,
): BelgianTaxHouseholdV2 | undefined {
    const b = household.partners.find((p) => p.id === "B");
    if (!b || !grossActivity(b)) return undefined;
    const next = applyProfileV1PatchToHousehold(household, {
        grossAnnualIncome: Math.max(0, cents(total - partnerB)),
    });
    const target = next.partners.find((p) => p.id === "B");
    const activity = target && grossActivity(target);
    if (activity) activity.grossIncome = Math.max(0, partnerB);
    return next;
}

/** Profile fields of a deduction candidate that live on the partner, not in `reductions`. */
const PARTNER_FIELDS = new Set<string>(["alimonyPaid", "unionDues"]);
/** Profile fields that live on the household's home and are never split. */
const HOME_FIELDS = new Set<string>(["mortgageInterestPaid"]);

/** True when the candidate's amount is a household-level (home) field, not a partner one. */
export function isHouseholdLevelDeduction(mapping: DeductionFieldMapping): boolean {
    return HOME_FIELDS.has(mapping.amountField);
}

/** Current value of a candidate's amount field for one partner (or for the home). */
export function deductionFieldValue(
    household: BelgianTaxHouseholdV2,
    partnerId: PartnerId,
    mapping: DeductionFieldMapping,
): number {
    const field = mapping.amountField;
    if (HOME_FIELDS.has(field)) {
        return Number((household.home as Record<string, unknown>)[field] ?? 0);
    }
    const partner = household.partners.find((p) => p.id === partnerId);
    if (!partner) return 0;
    const source: Record<string, unknown> = PARTNER_FIELDS.has(field)
        ? (partner as unknown as Record<string, unknown>)
        : (partner.reductions as Record<string, unknown>);
    return Number(source[field] ?? 0);
}

/**
 * Apply a confirmed deduction candidate to a household (SET semantics, never added). Each
 * partner with a positive share gets that share and, where the field has one, its eligibility
 * flag; a partner whose share is 0 keeps their value. A home field receives `total`.
 */
export function applyDeductionCandidate(
    household: BelgianTaxHouseholdV2,
    mapping: DeductionFieldMapping,
    shares: PartnerAmounts,
    total: number,
): BelgianTaxHouseholdV2 {
    const field = mapping.amountField;
    if (HOME_FIELDS.has(field)) {
        return { ...household, home: { ...household.home, [field]: total } };
    }
    return {
        ...household,
        partners: household.partners.map((partner) => {
            const share = shares[partner.id];
            if (!(share > 0)) return partner;
            if (PARTNER_FIELDS.has(field)) return { ...partner, [field]: share };
            const reductions: Record<string, unknown> = {
                ...partner.reductions,
                [field]: share,
            };
            if (mapping.eligibilityField) reductions[mapping.eligibilityField] = true;
            return {
                ...partner,
                reductions: reductions as HouseholdPartner["reductions"],
            };
        }),
    };
}
