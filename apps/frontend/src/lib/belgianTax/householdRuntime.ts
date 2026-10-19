/**
 * Household shape helpers for the Belgian-tax store (ADR-200): the v1 projection, the v1 patch
 * and the schema check of household edits. No tax is computed and no assessment is decided here;
 * the server computes every figure (GET /api/belgian-tax/overview, POST /api/belgian-tax/compute).
 *
 * `BelgianTaxProfileProvider` loads this module with a dynamic import and hands it to the
 * store at hydration, so the zod schemas of `householdSchema.ts` stay out of the boot preload
 * graph (see apps/frontend/scripts/check-bundle-size.ts). Do not import it statically from
 * boot-path modules; type-only imports are fine.
 */
import { parseHouseholdV2 } from "./householdSchema";
import {
    applyProfileV1PatchToHousehold as applyProfileV1Patch,
    projectHouseholdToProfileV1,
} from "./householdMigration";
import type {
    BelgianTaxHouseholdSnapshotsV2,
    BelgianTaxHouseholdV2,
} from "./householdTypes";
import type { BelgianTaxProfile, BelgianTaxProfileSnapshots } from "./types";
import logger from "@/lib/logger";

export { defaultHousehold } from "@vision/shared-utils/belgian-tax/settings";

/**
 * v1 projection of a household, completed with the v1 defaults for fields it does not set. The
 * browser does not decide the assessment (ADR-217): with partner B, `filingStatus` is left out,
 * and the server's `assessment` of the year's figures says how the household files.
 */
export function projectProfileV1(
    household: BelgianTaxHouseholdV2,
    defaults: BelgianTaxProfile,
): BelgianTaxProfile {
    const { filingStatus: _defaultFilingStatus, ...rest } = defaults;
    return { ...rest, ...projectHouseholdToProfileV1(household, undefined) };
}

/**
 * Apply a v1 profile patch to a household. The v1 editors never patch the spouse fields without a
 * filing status, so no joint-filing check is needed.
 */
export function applyProfileV1PatchToHousehold(
    household: BelgianTaxHouseholdV2,
    patch: Partial<BelgianTaxProfile>,
): BelgianTaxHouseholdV2 {
    return applyProfileV1Patch(household, patch, undefined);
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
