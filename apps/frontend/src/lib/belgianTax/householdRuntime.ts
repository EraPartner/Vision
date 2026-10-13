/**
 * Household engine entry point for the Belgian-tax store (ADR-200, phase B2).
 *
 * `BelgianTaxProfileProvider` loads this module with a dynamic import and hands it to the
 * store at hydration, so the household engine and the zod schemas of `householdSchema.ts`
 * stay out of the boot preload graph (see apps/frontend/scripts/check-bundle-size.ts).
 * Do not import it statically from boot-path modules; type-only imports are fine.
 */
import { parseHouseholdV2 } from "./householdSchema";
import { computeHouseholdTax, toBelgianTaxCalculation } from "./household";
import { projectHouseholdToProfileV1 } from "./householdMigration";
import type {
    BelgianTaxHouseholdSnapshotsV2,
    BelgianTaxHouseholdV2,
    HouseholdTaxResult,
} from "./householdTypes";
import type {
    BelgianTaxCalculation,
    BelgianTaxProfile,
    BelgianTaxProfileSnapshots,
} from "./types";
import logger from "@/lib/logger";

export { computeHouseholdTax, toBelgianTaxCalculation } from "./household";
export { deriveAssessment } from "./assessment";
export {
    applyProfileV1PatchToHousehold,
    projectHouseholdToProfileV1,
    upgradeProfileV1ToHousehold,
    upgradeSnapshotsV1ToV2,
} from "./householdMigration";

export {
    defaultHousehold,
    loadHouseholdSettings,
} from "@vision/shared-utils/belgian-tax/settings";
export type {
    StoredBelgianTaxSettings,
    LoadedHouseholdSettings,
    HouseholdSettingsWarning,
} from "@vision/shared-utils/belgian-tax/settings";

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
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key]))
            diff[key] = b[key];
    }
    return diff as Partial<BelgianTaxHouseholdV2>;
}

/**
 * Household edit: a shallow patch of top-level household fields, or an updater that returns
 * the next household from a private copy of the current one.
 */
export type HouseholdUpdate =
    | Partial<Omit<BelgianTaxHouseholdV2, "version">>
    | ((household: BelgianTaxHouseholdV2) => BelgianTaxHouseholdV2);

/**
 * Apply a `HouseholdUpdate`. Returns `undefined`, and logs the issues, when the result fails
 * the settings schema, so an invalid edit never reaches the store or the settings API.
 */
export function applyHouseholdUpdate(
    current: BelgianTaxHouseholdV2,
    update: HouseholdUpdate,
): BelgianTaxHouseholdV2 | undefined {
    const next: BelgianTaxHouseholdV2 =
        typeof update === "function"
            ? update(structuredClone(current))
            : { ...current, ...update, version: 2 };
    const parsed = parseHouseholdV2(next);
    if (!parsed.ok) {
        logger.warn(
            "Rejected an invalid Belgian tax household edit",
            parsed.issues,
        );
        return undefined;
    }
    return next;
}
