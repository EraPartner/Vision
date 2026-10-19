/** Recorded-income attribution shares the backend TypeScript implementation. */
export {
    householdHasPartnerB,
    partnerBShare,
    attributeToPartners,
    householdWithRecordedIncome,
    householdForRecordedIncome,
} from "@vision/shared-utils/belgian-tax/recordedIncomeAttribution";
export type { PartnerAmounts } from "@vision/shared-utils/belgian-tax/recordedIncomeAttribution";
import type { PartnerAmounts } from "@vision/shared-utils/belgian-tax/recordedIncomeAttribution";
import type { DeductionFieldMapping } from "./deductionCandidateFields";
import type {
    BelgianTaxHouseholdV2,
    HouseholdPartner,
    PartnerId,
} from "./householdTypes";

/** Profile fields of a deduction candidate that live on the partner, not in `reductions`. */
const PARTNER_FIELDS = new Set<string>(["alimonyPaid", "unionDues"]);
/** Profile fields that live on the household's home and are never split. */
const HOME_FIELDS = new Set<string>(["mortgageInterestPaid"]);

/** True when the candidate's amount is a household-level (home) field, not a partner one. */
export function isHouseholdLevelDeduction(
    mapping: DeductionFieldMapping,
): boolean {
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
        : partner.reductions;
    return Number(source[field] ?? 0);
}

/**
 * Apply a confirmed deduction candidate to a household (SET semantics, never added). Every
 * partner receives their share, including 0, so an amount that moved from one partner's account
 * to the other's is not counted twice. The eligibility flag, where the field has one, is set only
 * for a positive share and otherwise left as it was. A home field receives `total`.
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
            const raw = shares[partner.id];
            const share = Number.isFinite(raw) && raw > 0 ? raw : 0;
            if (PARTNER_FIELDS.has(field))
                return { ...partner, [field]: share };
            const reductions: Record<string, unknown> = {
                ...partner.reductions,
                [field]: share,
            };
            if (mapping.eligibilityField && share > 0)
                reductions[mapping.eligibilityField] = true;
            return {
                ...partner,
                reductions: reductions as HouseholdPartner["reductions"],
            };
        }),
    };
}
