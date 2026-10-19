import { describe, expect, test } from "vitest";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "../../src/belgianTax/profileDefaults.ts";
// The upgrade runs on the server (GET /api/belgian-tax/overview).
import {
    loadHouseholdSettings,
    type StoredBelgianTaxSettings,
} from "../../src/belgianTax/settings.ts";
import { parseHouseholdSnapshotsV2, parseHouseholdV2 } from "../../src/belgianTax/householdSchema.ts";
import { upgradeProfileV1ToHousehold } from "../../src/belgianTax/householdMigration.ts";
import type { BelgianTaxProfile } from "../../src/belgianTax/types.ts";

/** Stored settings as the provider passes them: the v1 profile merged over the v1 defaults. */
function stored(
    profileV1: Record<string, unknown> | undefined,
    extra: Partial<StoredBelgianTaxSettings> = {},
): StoredBelgianTaxSettings {
    return {
        defaultsV1: DEFAULT_BELGIAN_TAX_PROFILE,
        profileV1: {
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            ...(profileV1 ?? {}),
        } as BelgianTaxProfile,
        hasProfileV1: profileV1 !== undefined,
        snapshotsV1: null,
        householdV2: null,
        snapshotsV2: null,
        ...extra,
    };
}

describe("loadHouseholdSettings: v1 values the v2 schema rejects", () => {
    test.each([
        ["mortgageStartYear"],
        ["annualDividendIncome"],
        ["dependentChildrenUnder3"],
        ["region"],
        ["additionalResidences"],
        ["taxIncomeCategoryIds"],
    ])("treats a null %s as absent and writes a valid household", (field) => {
        const loaded = loadHouseholdSettings(
            stored({ grossAnnualIncome: 41_000, [field]: null }),
        );
        expect(parseHouseholdV2(loaded.household).ok).toBe(true);
        expect(loaded.writeHousehold).toBe(true);
        expect(loaded.warnings).toEqual([]);
        expect(loaded.household.partners[0]?.activities[0]?.grossIncome).toBe(
            41_000,
        );
    });

    test("upgrades a null field directly to an absent one", () => {
        const household = upgradeProfileV1ToHousehold({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            mortgageStartYear: null,
            annualDividendIncome: null,
            dependentChildrenUnder3: null,
        } as unknown as BelgianTaxProfile);
        expect(household.home).not.toHaveProperty("mortgageStartYear");
        expect(household.partners[0]).not.toHaveProperty(
            "annualDividendIncome",
        );
        expect(household.dependents).not.toHaveProperty("childrenUnder3");
        expect(household.migratedFrom?.unmappedFields).toEqual([]);
        expect(parseHouseholdV2(household).ok).toBe(true);
    });

    test("merges the v1 defaults into a v1 snapshot without region", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        const loaded = loadHouseholdSettings(
            stored(
                {},
                {
                    snapshotsV1: {
                        [year]: { grossAnnualIncome: 30_000, mortgageStartYear: null },
                    },
                },
            ),
        );
        expect(parseHouseholdSnapshotsV2(loaded.snapshots).ok).toBe(true);
        expect(loaded.writeSnapshots).toBe(true);
        expect(loaded.snapshots[year]?.region).toBe("flanders");
        expect(
            loaded.snapshots[year]?.partners[0]?.activities[0]?.grossIncome,
        ).toBe(30_000);
    });

    test("does not write an upgrade that still fails validation", () => {
        const loaded = loadHouseholdSettings(
            stored({ communalSurchargePercent: 42 }),
        );
        expect(loaded.writeHousehold).toBe(false);
        expect(loaded.warnings).toEqual([
            expect.objectContaining({
                key: "belgian_tax_household_v2",
                kind: "invalid_upgrade",
            }),
        ]);
        expect(loaded.household.communalSurchargePercent).toBe(42);
    });

    test("does not write upgraded snapshots that still fail validation", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        const loaded = loadHouseholdSettings(
            stored(undefined, {
                snapshotsV1: { [year]: { communalSurchargePercent: 42 } },
            }),
        );
        expect(loaded.writeSnapshots).toBe(false);
        expect(loaded.warnings).toEqual([
            expect.objectContaining({
                key: "belgian_tax_household_snapshots_v2",
                kind: "invalid_upgrade",
            }),
        ]);
    });
});

describe("loadHouseholdSettings: invalid stored v2 values", () => {
    test("reports the stored raw value and flags the fallback", () => {
        const raw = { version: 2, taxYear: "nope" };
        const loaded = loadHouseholdSettings(
            stored({ grossAnnualIncome: 41_000 }, { householdV2: raw }),
        );
        expect(loaded.writeHousehold).toBe(false);
        expect(loaded.storedValueInvalid).toBe(true);
        expect(loaded.warnings).toEqual([
            expect.objectContaining({
                key: "belgian_tax_household_v2",
                kind: "invalid_stored",
                stored: raw,
            }),
        ]);
    });

    test("does not flag valid stored values", () => {
        const loaded = loadHouseholdSettings(stored(undefined));
        expect(loaded.storedValueInvalid).toBe(false);
        expect(loaded.warnings).toEqual([]);
    });
});
