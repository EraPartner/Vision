import { z } from "zod";
import { DEFAULT_BELGIAN_TAX_PROFILE, hasMeaningfulBelgianTaxData } from "@vision/shared-utils/belgian-tax/profileDefaults";
import type { BelgianTaxProfile, BelgianTaxProfileSnapshotMetas } from "@/lib/belgianTax/types";
import type { HouseholdTaxResult } from "@/lib/belgianTax/householdTypes";
import type { HouseholdRuntime } from "@/stores/belgianTaxStore";
import { taxReportContext, type TaxReportContext } from "@/features/reports/taxReportContext";

const snapshotSchema = z.strictObject({
    belgian_tax_profile: z.unknown().optional(),
    belgian_tax_profile_snapshots_v1: z.unknown().optional(),
    belgian_tax_household_v2: z.unknown().optional(),
    belgian_tax_household_snapshots_v2: z.unknown().optional(),
    belgian_tax_profile_snapshot_meta_v1: z.unknown().optional(),
});

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
}

/** Read-only provider hydration and original export composition from one fresh fiscal snapshot. */
export function taxReportContextFromSettings(
    raw: unknown,
    year: number,
    translate: (key: string) => string,
    runtime: HouseholdRuntime,
): TaxReportContext {
    const settings = snapshotSchema.parse(raw);
    const mergedProfile = {
        ...DEFAULT_BELGIAN_TAX_PROFILE,
        ...record(settings.belgian_tax_profile),
    } as BelgianTaxProfile;
    const loaded = runtime.loadHouseholdSettings({
        defaultsV1: DEFAULT_BELGIAN_TAX_PROFILE,
        profileV1: { ...mergedProfile, profileConfigured: hasMeaningfulBelgianTaxData(mergedProfile) },
        hasProfileV1: settings.belgian_tax_profile != null,
        snapshotsV1: settings.belgian_tax_profile_snapshots_v1,
        householdV2: settings.belgian_tax_household_v2,
        snapshotsV2: settings.belgian_tax_household_snapshots_v2,
    });
    let live = loaded.household;
    if (!live.profileConfigured && hasMeaningfulBelgianTaxData(runtime.projectHouseholdToProfileV1(live))) {
        live = { ...live, profileConfigured: true };
    }
    // A frozen filing needs no unused live preview. This getter is reached only when the
    // original resolver requires the current household's result instead of frozen data.
    let liveResult: HouseholdTaxResult | undefined;
    const state = {
        profile: runtime.projectProfileV1(live, DEFAULT_BELGIAN_TAX_PROFILE),
        snapshots: runtime.projectSnapshotsToV1(loaded.snapshots, DEFAULT_BELGIAN_TAX_PROFILE),
        household: live,
        householdSnapshots: loaded.snapshots,
        snapshotMetas: record(settings.belgian_tax_profile_snapshot_meta_v1) as BelgianTaxProfileSnapshotMetas,
        get householdResult() {
            return liveResult ??= runtime.computeHouseholdTax(live);
        },
    };
    return taxReportContext(state, year, translate, runtime);
}
