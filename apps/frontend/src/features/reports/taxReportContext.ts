import {
    resolveBelgianTaxCalculation,
    resolveBelgianTaxHousehold,
    resolveBelgianTaxHouseholdResult,
    resolveBelgianTaxProfile,
    type BelgianTaxSlice,
    type HouseholdRuntime,
} from "@/stores/belgianTaxStore";
import type { ReportOptions, TaxReportPIT } from "@/lib/api/reports";
import { toTaxReportHousehold } from "@/features/reports/taxReportHousehold";

export type TaxReportContextState = Pick<BelgianTaxSlice,
    "profile" | "snapshots" | "household" | "householdSnapshots" | "householdResult" | "snapshotMetas">;
export type TaxReportContext = Pick<ReportOptions,
    "taxProfile" | "precomputedPIT" | "household" | "precomputedHousehold">;

/** Original export composition, shared by the web dialog and native extreme-year fallback. */
export function taxReportContext(
    state: TaxReportContextState,
    year: number,
    translate: (key: string) => string,
    runtime?: HouseholdRuntime,
): TaxReportContext {
    const configured = state.profile.profileConfigured;
    const yearProfile = resolveBelgianTaxProfile(state, year);
    const taxProfile = configured ? {
        filingStatus: yearProfile.employmentType,
        region: yearProfile.region,
        taxYear: yearProfile.taxYear,
    } : undefined;
    let precomputedPIT: TaxReportPIT | undefined;
    let householdBlock: Pick<ReportOptions, "household" | "precomputedHousehold"> = {};
    if (configured) {
        const calculation = resolveBelgianTaxCalculation(state, year, runtime);
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
                ? null : resolveBelgianTaxHouseholdResult(state, year, runtime);
            householdBlock = { household, precomputedHousehold: toTaxReportHousehold(result) };
        }
    }
    return { taxProfile, precomputedPIT, ...householdBlock };
}
