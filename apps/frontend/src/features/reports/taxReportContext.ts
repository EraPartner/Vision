import {
    resolveBelgianTaxHousehold,
    resolveBelgianTaxProfile,
    resolveTaxYearFigures,
    type BelgianTaxSlice,
} from "@/stores/belgianTaxStore";
import type { ReportOptions, TaxReportPIT } from "@/lib/api/reports";
import { toTaxReportHousehold } from "@/features/reports/taxReportHousehold";
import type { TranslationKey } from "@/locales/keys";

export type TaxReportContextState = Pick<BelgianTaxSlice,
    "profile" | "snapshots" | "household" | "householdSnapshots" | "snapshotMetas">;
export type TaxReportContext = Pick<ReportOptions,
    "taxProfile" | "precomputedPIT" | "household" | "precomputedHousehold">;

/** Row labels for the Belgian PIT brackets; other bracket numbers keep the server label. */
const BRACKET_LABEL_KEYS: Partial<Record<number, TranslationKey>> = {
    1: "tax.pit.row.bracket1",
    2: "tax.pit.row.bracket2",
    3: "tax.pit.row.bracket3",
    4: "tax.pit.row.bracket4",
};

/** The export dialog's tax report options. Annual figures need a full calendar year that is the live year, has its own saved snapshot,
 * or has a frozen calculation (the same years that can be filed). They are the frozen figures of a frozen year, else the server's
 * computation of the year's household (POST /api/belgian-tax/compute); the reports endpoint renders them as sent. */
export async function taxReportContext(
    state: TaxReportContextState,
    year: number,
    translate: (key: TranslationKey) => string,
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
            brackets: calculation.breakdown.filter((entry) => entry.bracket).map((entry) => {
                const bracketKey = BRACKET_LABEL_KEYS[entry.bracketNumber ?? 0];
                return {
                    label: bracketKey ? translate(bracketKey) : entry.label,
                    rate: entry.rate,
                    taxAmount: entry.amount,
                };
            }),
        };
        const household = resolveBelgianTaxHousehold(state, year);
        if (household && household.partners.length === 2)
            // A year frozen before the household result was stored has none to report.
            householdBlock = { household, precomputedHousehold: toTaxReportHousehold(figures.householdResult) };
    }
    return { taxProfile, precomputedPIT, ...householdBlock };
}
