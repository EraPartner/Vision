/**
 * Household engine entry point for the Belgian-tax store (ADR-200, phase B2).
 *
 * `BelgianTaxProfileProvider` loads this module with a dynamic import and hands it to the
 * store at hydration, so the household engine and the zod schemas of `householdSchema.ts`
 * stay out of the boot preload graph (see apps/frontend/scripts/check-bundle-size.ts).
 * Do not import it statically from boot-path modules; type-only imports are fine.
 */
import { parseHouseholdSnapshotsV2, parseHouseholdV2 } from "./householdSchema";
import { computeHouseholdTax, toBelgianTaxCalculation } from "./household";
import {
    projectHouseholdToProfileV1,
    upgradeProfileV1ToHousehold,
    upgradeSnapshotsV1ToV2,
    withoutNullFields,
} from "./householdMigration";
import type {
    BelgianTaxHouseholdSnapshotsV2,
    BelgianTaxHouseholdV2,
    HouseholdTaxResult,
} from "./householdTypes";
import type { BelgianTaxCalculation, BelgianTaxProfile, BelgianTaxProfileSnapshots } from "./types";

export { computeHouseholdTax, toBelgianTaxCalculation } from "./household";
export {
    applyProfileV1PatchToHousehold,
    projectHouseholdToProfileV1,
    upgradeProfileV1ToHousehold,
    upgradeSnapshotsV1ToV2,
} from "./householdMigration";

/** Raw setting values as preloaded from the settings API (`null` when a key is absent). */
export interface StoredBelgianTaxSettings {
    /** v1 defaults, filled in for absent (or `null`) fields of the stored v1 values. */
    defaultsV1: BelgianTaxProfile;
    /** v1 profile merged over the v1 defaults; the defaults alone when the key is absent. */
    profileV1: BelgianTaxProfile;
    hasProfileV1: boolean;
    snapshotsV1: unknown;
    householdV2: unknown;
    snapshotsV2: unknown;
}

export interface LoadedHouseholdSettings {
    household: BelgianTaxHouseholdV2;
    snapshots: BelgianTaxHouseholdSnapshotsV2;
    /** True when the household was upgraded from a stored v1 profile and must be written now. */
    writeHousehold: boolean;
    /** True when the snapshots were upgraded from stored v1 snapshots and must be written now. */
    writeSnapshots: boolean;
    /**
     * True when a stored v2 value failed validation and was replaced in memory by the fallback;
     * the user's next edit overwrites the stored value, so the tax overview says so.
     */
    storedValueInvalid: boolean;
    /**
     * Validation problems: stored v2 values replaced by the fallback (`invalid_stored`), and
     * upgraded values that are kept in memory but not written (`invalid_upgrade`).
     */
    warnings: HouseholdSettingsWarning[];
}

export interface HouseholdSettingsWarning {
    key: "belgian_tax_household_v2" | "belgian_tax_household_snapshots_v2";
    kind: "invalid_stored" | "invalid_upgrade";
    issues: string[];
    /** The stored raw value (`invalid_stored` only), logged so it can be recovered by hand. */
    stored?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * v1 snapshots keyed by year, each merged over the v1 defaults (as the live v1 profile is) and
 * pinned to its key year before the upgrade.
 */
function normalizedSnapshotsV1(
    value: unknown,
    defaults: BelgianTaxProfile,
): BelgianTaxProfileSnapshots {
    const result: BelgianTaxProfileSnapshots = {};
    if (!isRecord(value)) return result;
    for (const [key, snapshot] of Object.entries(value)) {
        const year = Number(key);
        if (!Number.isInteger(year) || !isRecord(snapshot)) continue;
        result[year] = {
            ...defaults,
            ...withoutNullFields(snapshot as unknown as BelgianTaxProfile),
            taxYear: year,
        };
    }
    return result;
}

function withoutMigrationRecord(household: BelgianTaxHouseholdV2): BelgianTaxHouseholdV2 {
    const { migratedFrom: _migratedFrom, ...rest } = household;
    return rest;
}

/** A fresh household built from the v1 defaults, without a migration record. */
export function defaultHousehold(defaults: BelgianTaxProfile): BelgianTaxHouseholdV2 {
    return withoutMigrationRecord(upgradeProfileV1ToHousehold(defaults));
}

/**
 * Resolve the household and its snapshots from the stored settings. A valid v2 value wins and
 * is never rewritten; an absent v2 key is upgraded from the v1 key when that exists (and must
 * then be written, unless the upgrade fails validation); an invalid v2 value is reported in
 * `warnings` and falls back to the v1 upgrade or the defaults without being overwritten until the
 * user edits; the caller logs `warnings`. `null` v1 fields take the v1 defaults.
 */
export function loadHouseholdSettings(stored: StoredBelgianTaxSettings): LoadedHouseholdSettings {
    const profileV1 = { ...stored.defaultsV1, ...withoutNullFields(stored.profileV1) };
    const upgradeProfile = () =>
        stored.hasProfileV1 ? upgradeProfileV1ToHousehold(profileV1) : defaultHousehold(profileV1);

    const warnings: HouseholdSettingsWarning[] = [];
    let household: BelgianTaxHouseholdV2;
    let writeHousehold = false;
    if (stored.householdV2 != null) {
        const parsed = parseHouseholdV2(stored.householdV2);
        if (parsed.ok) {
            household = parsed.value;
        } else {
            warnings.push({
                key: "belgian_tax_household_v2",
                kind: "invalid_stored",
                issues: parsed.issues,
                stored: stored.householdV2,
            });
            household = upgradeProfile();
        }
    } else {
        household = upgradeProfile();
        writeHousehold = stored.hasProfileV1;
        // Never write a value the settings API would reject: every later save of the key fails too.
        const parsed = writeHousehold ? parseHouseholdV2(household) : undefined;
        if (parsed && !parsed.ok) {
            warnings.push({
                key: "belgian_tax_household_v2",
                kind: "invalid_upgrade",
                issues: parsed.issues,
            });
            writeHousehold = false;
        }
    }

    const upgradeSnapshots = () =>
        upgradeSnapshotsV1ToV2(normalizedSnapshotsV1(stored.snapshotsV1, stored.defaultsV1));
    let snapshots: BelgianTaxHouseholdSnapshotsV2;
    let writeSnapshots = false;
    if (stored.snapshotsV2 != null) {
        const parsed = parseHouseholdSnapshotsV2(stored.snapshotsV2);
        if (parsed.ok) {
            snapshots = parsed.value;
        } else {
            warnings.push({
                key: "belgian_tax_household_snapshots_v2",
                kind: "invalid_stored",
                issues: parsed.issues,
                stored: stored.snapshotsV2,
            });
            snapshots = upgradeSnapshots();
        }
    } else {
        snapshots = upgradeSnapshots();
        writeSnapshots = stored.snapshotsV1 != null;
        const parsed = writeSnapshots ? parseHouseholdSnapshotsV2(snapshots) : undefined;
        if (parsed && !parsed.ok) {
            warnings.push({
                key: "belgian_tax_household_snapshots_v2",
                kind: "invalid_upgrade",
                issues: parsed.issues,
            });
            writeSnapshots = false;
        }
    }

    const storedValueInvalid = warnings.some((w) => w.kind === "invalid_stored");
    return { household, snapshots, writeHousehold, writeSnapshots, storedValueInvalid, warnings };
}

/** v1 projection of a household, completed with the v1 defaults for fields it does not set. */
export function projectProfileV1(
    household: BelgianTaxHouseholdV2,
    defaults: BelgianTaxProfile,
): BelgianTaxProfile {
    return { ...defaults, ...projectHouseholdToProfileV1(household) };
}

/** v1 projection of every household snapshot. */
export function projectSnapshotsToV1(
    snapshots: BelgianTaxHouseholdSnapshotsV2,
    defaults: BelgianTaxProfile,
): BelgianTaxProfileSnapshots {
    const result: BelgianTaxProfileSnapshots = {};
    for (const [year, household] of Object.entries(snapshots)) {
        result[Number(year)] = projectProfileV1(household, defaults);
    }
    return result;
}

export interface LiveHouseholdState {
    household: BelgianTaxHouseholdV2;
    householdResult: HouseholdTaxResult;
    calculation: BelgianTaxCalculation;
    profile: BelgianTaxProfile;
}

/** Engine result, v1-shaped calculation and v1 projection of a household. */
export function liveHouseholdState(
    household: BelgianTaxHouseholdV2,
    defaults: BelgianTaxProfile,
): LiveHouseholdState {
    const householdResult = computeHouseholdTax(household);
    return {
        household,
        householdResult,
        calculation: toBelgianTaxCalculation(householdResult, household),
        profile: projectProfileV1(household, defaults),
    };
}

/** Top-level household fields whose value differs, with their new value (`taxYear` excluded). */
export function diffHousehold(
    before: BelgianTaxHouseholdV2,
    after: BelgianTaxHouseholdV2,
): Partial<BelgianTaxHouseholdV2> {
    const diff: Record<string, unknown> = {};
    const a = before as unknown as Record<string, unknown>;
    const b = after as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (key === "taxYear") continue;
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) diff[key] = b[key];
    }
    return diff as Partial<BelgianTaxHouseholdV2>;
}
