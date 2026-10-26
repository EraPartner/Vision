import { computeHouseholdTax, toBelgianTaxCalculation } from "./household.ts";
import { loadHouseholdSettings } from "./settings.ts";
import { projectHouseholdToProfileV1 } from "./householdMigration.ts";
import { filesJointly } from "./assessment.ts";
import {
    DEFAULT_BELGIAN_TAX_PROFILE,
    hasMeaningfulBelgianTaxData,
} from "./profileDefaults.ts";
import type { HouseholdTaxResult } from "./householdTypes.ts";

/** Persisted baseline of one setting, as the settings CAS protocol carries it. */
export interface TaxOverviewSettingBaseline {
    exists: boolean;
    value?: unknown;
}

/** The Belgian-tax settings keys an overview hands back with their CAS baselines. */
export const TAX_OVERVIEW_SETTING_KEYS = [
    "belgian_tax_household_v2",
    "belgian_tax_household_snapshots_v2",
    "belgian_tax_profile_snapshot_meta_v1",
] as const;

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * Belgian-tax overview of `requestedYear` (default: the live year) from one read of the stored
 * settings and their baselines: the shared v1/v2 hydration, frozen-first figures, and the
 * engine result for a year that is not fully frozen. Pure; GET /api/belgian-tax/overview
 * serves it.
 */
export function buildTaxOverview(
    settings: Record<string, unknown>,
    expected: Record<string, TaxOverviewSettingBaseline>,
    requestedYear?: number,
) {
    const mergedProfile = {
        ...DEFAULT_BELGIAN_TAX_PROFILE,
        ...record(settings.belgian_tax_profile),
    };
    const loaded = loadHouseholdSettings({
        defaultsV1: DEFAULT_BELGIAN_TAX_PROFILE,
        profileV1: {
            ...mergedProfile,
            profileConfigured: hasMeaningfulBelgianTaxData(mergedProfile),
        },
        hasProfileV1: settings.belgian_tax_profile != null,
        snapshotsV1: settings.belgian_tax_profile_snapshots_v1,
        householdV2: settings.belgian_tax_household_v2,
        snapshotsV2: settings.belgian_tax_household_snapshots_v2,
    });
    let live = loaded.household;
    if (
        !live.profileConfigured &&
        hasMeaningfulBelgianTaxData(projectHouseholdToProfileV1(live, filesJointly))
    ) {
        live = { ...live, profileConfigured: true };
    }
    const year = requestedYear ?? live.taxYear;
    const household =
        year === live.taxYear
            ? live
            : (loaded.snapshots[year] ?? { ...live, taxYear: year });
    const snapshotMetas = record(settings.belgian_tax_profile_snapshot_meta_v1);
    const metadata = record(snapshotMetas[year]);
    const frozenCalculation = metadata.frozenCalculation;
    const frozenResult = metadata.frozenHouseholdResult;
    // A fully frozen filing must not run through a newer engine, even as an unused preview.
    let computed: HouseholdTaxResult | undefined;
    const currentResult = () => (computed ??= computeHouseholdTax(household));
    const calculation =
        frozenCalculation ?? toBelgianTaxCalculation(currentResult(), household);
    const result = frozenResult ?? currentResult();
    return {
        year,
        liveYear: live.taxYear,
        isHistorical: year !== live.taxYear,
        hasSnapshot: Object.hasOwn(loaded.snapshots, year),
        hasProfile: live.profileConfigured,
        household,
        liveHousehold: live,
        householdSnapshots: loaded.snapshots,
        snapshotMetas,
        metadata,
        calculation,
        result,
        calculationSource: frozenCalculation != null ? "frozen" : "computed",
        householdResultSource: frozenResult != null ? "frozen" : "computed",
        householdMigrationNeeded: loaded.writeHousehold,
        snapshotsMigrationNeeded: loaded.writeSnapshots,
        storedValueInvalid: loaded.storedValueInvalid,
        warnings: loaded.warnings.map(({ key, kind, issues }) => ({
            key,
            kind,
            issues,
        })),
        // Original values/baselines are retained, including absent vs JSON null and legacy JSON strings.
        records: TAX_OVERVIEW_SETTING_KEYS.map((key) => ({
            key,
            value: settings[key] ?? null,
            expected: expected[key] ?? { exists: false },
        })),
    };
}
