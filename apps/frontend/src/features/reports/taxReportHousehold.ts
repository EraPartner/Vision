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
 * The calendar year a tax report period covers, which is the tax year its PIT and household
 * blocks must describe; `undefined` when the period is not a single calendar year (a rolling
 * window, or a custom range across years), and the report then carries no such blocks. A year
 * to date is the current calendar year (`today`, YYYY-MM-DD), and a custom range counts when
 * it starts and ends in the same calendar year, matching the backend's tax year for the period.
 */
export function reportTaxYear(period: ReportPeriod, today: string): number | undefined {
    switch (period.kind) {
        case "year":
            return period.year;
        case "ytd":
            return Number(today.slice(0, 4));
        case "custom": {
            const from = Number(period.from.slice(0, 4));
            return from === Number(period.to.slice(0, 4)) ? from : undefined;
        }
        case "rolling":
            return undefined;
    }
}
