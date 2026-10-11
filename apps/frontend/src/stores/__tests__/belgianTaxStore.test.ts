import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import {
    DEFAULT_BELGIAN_TAX_PROFILE,
    resolveBelgianTaxCalculation,
    resolveBelgianTaxProfile,
} from "@/stores/belgianTaxStore";
import * as runtime from "@/lib/belgianTax/householdRuntime";
import {
    computeBelgianPIT,
    type BelgianTaxHouseholdV2,
    type BelgianTaxProfile,
} from "@/lib/belgianTax";

function householdOf(profile: BelgianTaxProfile): BelgianTaxHouseholdV2 {
    return runtime.upgradeProfileV1ToHousehold(profile);
}

function hydrate(
    profile: BelgianTaxProfile,
    snapshots: Record<number, BelgianTaxProfile> = {},
) {
    useSettingsStore
        .getState()
        ._hydrate(
            runtime,
            householdOf(profile),
            runtime.upgradeSnapshotsV1ToV2(snapshots),
            {},
        );
}

describe("Belgian tax settings slice", () => {
    beforeEach(() => {
        hydrate(DEFAULT_BELGIAN_TAX_PROFILE);
    });

    it("updates the live profile and calculation atomically", () => {
        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 50_000 });
        const state = useSettingsStore.getState();
        expect(state.profile.grossAnnualIncome).toBe(50_000);
        expect(state.calculation.grossIncome).toBe(50_000);
        expect(state.household?.partners[0]?.activities[0]?.grossIncome).toBe(
            50_000,
        );
        expect(state.householdResult?.totals.totalPIT).toBe(
            state.calculation.totalPIT,
        );
    });

    it("gives a one-partner household the same calculation as computeBelgianPIT on the projected profile", () => {
        hydrate({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            profileConfigured: true,
            grossAnnualIncome: 64_000,
            region: "brussels",
            dependentChildren: 2,
            personalPensionContributions: 1_020,
            pensionEligible: true,
            cadastralIncome: 1_250,
        });
        const state = useSettingsStore.getState();
        expect(state.household?.partners).toHaveLength(1);
        expect(state.calculation).toEqual(computeBelgianPIT(state.profile));

        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 41_500 });
        const updated = useSettingsStore.getState();
        expect(updated.calculation).toEqual(computeBelgianPIT(updated.profile));
    });

    it("computes a two-partner household through the household engine", () => {
        hydrate({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            grossAnnualIncome: 60_000,
            filingStatus: "married_joint",
            spouseProfessionalIncome: 15_000,
        });
        const state = useSettingsStore.getState();
        expect(state.household?.partners.map((p) => p.id)).toEqual(["A", "B"]);
        expect(state.householdResult?.assessment.mode).toBe("joint");
        const result = runtime.computeHouseholdTax(state.household!);
        expect(state.calculation).toEqual(
            runtime.toBelgianTaxCalculation(result, state.household!),
        );
        expect(state.profile.filingStatus).toBe("married_joint");
        expect(state.profile.spouseProfessionalIncome).toBe(15_000);
    });

    it("archives an advancing profile and its audit entry atomically", () => {
        const year = useSettingsStore.getState().profile.taxYear;
        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 50_000 });
        useSettingsStore.getState().updateProfile({ taxYear: year + 1 });
        const state = useSettingsStore.getState();
        expect(state.snapshots[year]?.grossAnnualIncome).toBe(50_000);
        expect(state.householdSnapshots[year]?.taxYear).toBe(year);
        expect(
            state.snapshotMetas[year]?.history?.map((entry) => entry.kind),
        ).toEqual(["created"]);
    });

    it("resolves current snapshots and frozen calculations from reactive state", () => {
        const liveYear = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        const historicalYear = liveYear - 1;
        hydrate(
            { ...DEFAULT_BELGIAN_TAX_PROFILE, grossAnnualIncome: 60_000 },
            {
                [historicalYear]: {
                    ...DEFAULT_BELGIAN_TAX_PROFILE,
                    taxYear: historicalYear,
                    grossAnnualIncome: 45_000,
                },
            },
        );
        useSettingsStore.getState().freezeCalculation(historicalYear);

        const state = useSettingsStore.getState();
        expect(resolveBelgianTaxProfile(state, liveYear)).toBe(state.profile);
        expect(
            resolveBelgianTaxProfile(state, historicalYear).grossAnnualIncome,
        ).toBe(45_000);
        expect(resolveBelgianTaxCalculation(state, historicalYear)).toBe(
            state.snapshotMetas[historicalYear]!.frozenCalculation,
        );
    });

    it("freezes the household result next to the calculation and drops both on unfreeze", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        useSettingsStore.getState().createSnapshotFromLive(year);
        useSettingsStore.getState().freezeCalculation(year);
        const meta = useSettingsStore.getState().snapshotMetas[year]!;
        expect(meta.frozenHouseholdResult?.engineVersion).toBe(2);
        expect(meta.frozenHouseholdResult?.totals.totalPIT).toBe(
            meta.frozenCalculation?.totalPIT,
        );

        useSettingsStore.getState().unfreezeCalculation(year);
        const after = useSettingsStore.getState().snapshotMetas[year]!;
        expect(after.frozenCalculation).toBeUndefined();
        expect(after.frozenHouseholdResult).toBeUndefined();
    });

    it("records the household diff next to the profile diff when a snapshot is patched", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        useSettingsStore.getState().createSnapshotFromLive(year);
        useSettingsStore.getState().updateSnapshot(year, {
            grossAnnualIncome: 30_000,
            region: "wallonia",
        });
        const entry = useSettingsStore
            .getState()
            .getSnapshotHistory(year)
            .at(-1)!;
        expect(entry.kind).toBe("patched");
        expect(entry.changes).toEqual({
            grossAnnualIncome: 30_000,
            region: "wallonia",
        });
        expect(entry.householdChanges?.region).toBe("wallonia");
        expect(
            entry.householdChanges?.partners?.[0]?.activities[0]?.grossIncome,
        ).toBe(30_000);
        expect(Object.keys(entry.householdChanges ?? {}).sort()).toEqual([
            "partners",
            "region",
        ]);
    });
});
