import {
    resolveBelgianTaxHousehold,
    resolveBelgianTaxProfile,
    resolveTaxYearFigures,
    type BelgianTaxSlice,
} from "@/stores/belgianTaxStore";
import type { ReportOptions, TaxReportPIT } from "@/lib/api/reports";
import { toTaxReportHousehold } from "@/features/reports/taxReportHousehold";

export type TaxReportContextState = Pick<BelgianTaxSlice,
    "profile" | "snapshots" | "household" | "householdSnapshots" | "snapshotMetas">;
export type TaxReportContext = Pick<ReportOptions,
    "taxProfile" | "precomputedPIT" | "household" | "precomputedHousehold">;

/** The export dialog's tax report options. Annual figures need a full calendar year that is the live year, has its own saved snapshot,
 * or has a frozen calculation (the same years that can be filed). They are the frozen figures of a frozen year, else the server's
 * computation of the year's household (POST /api/belgian-tax/compute); the reports endpoint renders them as sent. */
export async function taxReportContext(
    state: TaxReportContextState,
    year: number,
    translate: (key: string) => string,
    annual = true,
): Promise<TaxReportContext> {
    const hasYearProfile =
        annual &&
        (year === state.profile.taxYear ||
            Object.hasOwn(state.householdSnapshots, year) ||
            Boolean(state.snapshotMetas[year]?.frozenCalculation));
    const configured = hasYearProfile && state.profile.profileConfigured;
    const yearProfile = resolveBelgianTaxProfile(state, year);
    const taxProfile = configured ? {
        filingStatus: yearProfile.employmentType,
        region: yearProfile.region,
        taxYear: yearProfile.taxYear,
    } : undefined;
    let precomputedPIT: TaxReportPIT | undefined;
    let householdBlock: Pick<ReportOptions, "household" | "precomputedHousehold"> = {};
    const figures = configured ? await resolveTaxYearFigures(state, year) : undefined;
    if (figures) {
        const { calculation } = figures;
        precomputedPIT = {
            taxableIncome: calculation.taxableIncome,
            totalTax: calculation.totalPIT,
            brackets: calculation.breakdown.filter((entry) => entry.bracket).map((entry) => ({
                label: (entry.bracketNumber ?? 0) !== 0 ? translate(`tax.pit.row.bracket${entry.bracketNumber}`) : entry.label,
                rate: entry.rate,
                taxAmount: entry.amount,
            })),
        };
        const household = resolveBelgianTaxHousehold(state, year);
        if (household && household.partners.length === 2)
            // A year frozen before the household result was stored has none to report.
            householdBlock = { household, precomputedHousehold: toTaxReportHousehold(figures.householdResult) };
    }
    return { taxProfile, precomputedPIT, ...householdBlock };
}
