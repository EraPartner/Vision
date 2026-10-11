import type { HouseholdTaxResult } from "@/lib/belgianTax/householdTypes";
import type { ReportPeriod, TaxReportHousehold } from "@/lib/api/reports";

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

/**
 * The tax year a report period describes, which its PIT and household blocks must use. Mirrors
 * the backend's `periodToTaxContext` so the blocks carry the same year as the section heading:
 * a full year is that year; the year to date and a rolling window use the current year (`today`,
 * YYYY-MM-DD); a custom range uses the year it starts in. The backend adds a note to the report
 * when a rolling or custom period spans two calendar years.
 */
export function reportTaxYear(period: ReportPeriod, today: string): number {
    switch (period.kind) {
        case "year":
            return period.year;
        case "custom":
            return Number(period.from.slice(0, 4));
        case "ytd":
        case "rolling":
            return Number(today.slice(0, 4));
    }
}
