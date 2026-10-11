import type { HouseholdTaxResult } from "@/lib/belgianTax/householdTypes";
import type { TaxReportHousehold } from "@/lib/api/reports";

/**
 * Compact per-partner household result for the PDF tax report (ADR-200/201): the assessment,
 * the marital quotient and each partner's gross income, taxable income and tax. `undefined`
 * without a result, so the report keeps its one-person rows.
 */
export function toTaxReportHousehold(
    result: HouseholdTaxResult | null | undefined,
): TaxReportHousehold | undefined {
    if (!result) return undefined;
    const { assessment, quotient } = result;
    return {
        assessmentMode: assessment.mode,
        legalBasis: assessment.legalBasis,
        quotient: {
            applied: quotient.applied,
            transfer: quotient.transfer,
            ...(quotient.fromPartnerId ? { fromPartnerId: quotient.fromPartnerId } : {}),
            ...(quotient.toPartnerId ? { toPartnerId: quotient.toPartnerId } : {}),
            benefit: quotient.benefit,
        },
        partners: result.partners.map((p) => ({
            partnerId: p.partnerId,
            grossIncome: p.grossIncome,
            taxableIncome: p.taxableIncome,
            totalPIT: p.totalPIT,
        })),
    };
}
