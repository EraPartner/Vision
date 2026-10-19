import {
    resolveBelgianTaxCalculation,
    resolveBelgianTaxHousehold,
    resolveBelgianTaxHouseholdResult,
    resolveBelgianTaxProfile,
    type BelgianTaxSlice,
} from "@/stores/belgianTaxStore";
import type { ReportOptions, TaxReportPIT } from "@/lib/api/reports";
import { toTaxReportHousehold } from "@/features/reports/taxReportHousehold";

export type TaxReportContextState = Pick<BelgianTaxSlice,
    "profile" | "snapshots" | "household" | "householdSnapshots" | "householdResult" | "snapshotMetas">;
export type TaxReportContext = Pick<ReportOptions,
    "taxProfile" | "precomputedPIT" | "household" | "precomputedHousehold">;

/** The export dialog's tax report options. Annual figures need a full calendar year that is the live year, has its own saved snapshot,
 * or has a frozen calculation (the same years that can be filed). */
export function taxReportContext(
    state: TaxReportContextState,
    year: number,
    translate: (key: string) => string,
    annual = true,
): TaxReportContext {
    const hasYearProfile =
        annual &&
        (year === state.profile.taxYear ||
            Object.hasOwn(state.householdSnapshots, year) ||
            Boolean(state.snapshotMetas[year]?.frozenCalculation));
    const configured = hasYearProfile && state.profile.profileConfigured === true;
    const yearProfile = resolveBelgianTaxProfile(state, year);
    const taxProfile = configured ? {
        filingStatus: yearProfile.employmentType,
        region: yearProfile.region,
        taxYear: yearProfile.taxYear,
    } : undefined;
    let precomputedPIT: TaxReportPIT | undefined;
    let householdBlock: Pick<ReportOptions, "household" | "precomputedHousehold"> = {};
    if (configured) {
        const calculation = resolveBelgianTaxCalculation(state, year);
        precomputedPIT = {
            taxableIncome: calculation.taxableIncome,
            totalTax: calculation.totalPIT,
            brackets: calculation.breakdown.filter((entry) => entry.bracket).map((entry) => ({
                label: entry.bracketNumber ? translate(`tax.pit.row.bracket${entry.bracketNumber}`) : entry.label,
                rate: entry.rate,
                taxAmount: entry.amount,
            })),
        };
        const household = resolveBelgianTaxHousehold(state, year);
        if (household && household.partners.length === 2) {
            const meta = state.snapshotMetas[year];
            const result = meta?.frozenCalculation && !meta.frozenHouseholdResult
                ? null : resolveBelgianTaxHouseholdResult(state, year);
            householdBlock = { household, precomputedHousehold: toTaxReportHousehold(result) };
        }
    }
    return { taxProfile, precomputedPIT, ...householdBlock };
}
