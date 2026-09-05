import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import {
    DEFAULT_BELGIAN_TAX_PROFILE,
    resolveBelgianTaxCalculation,
    resolveBelgianTaxProfile,
} from "@/stores/belgianTaxStore";

describe("Belgian tax settings slice", () => {
    beforeEach(() => {
        useSettingsStore
            .getState()
            ._hydrate(DEFAULT_BELGIAN_TAX_PROFILE, {}, {});
    });

    it("updates the live profile and calculation atomically", () => {
        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 50_000 });
        const state = useSettingsStore.getState();
        expect(state.profile.grossAnnualIncome).toBe(50_000);
        expect(state.calculation.grossIncome).toBe(50_000);
    });

    it("archives an advancing profile and its audit entry atomically", () => {
        const year = useSettingsStore.getState().profile.taxYear;
        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 50_000 });
        useSettingsStore.getState().updateProfile({ taxYear: year + 1 });
        const state = useSettingsStore.getState();
        expect(state.snapshots[year].grossAnnualIncome).toBe(50_000);
        expect(
            state.snapshotMetas[year].history?.map((entry) => entry.kind),
        ).toEqual(["created"]);
    });

    it("resolves current snapshots and frozen calculations from reactive state", () => {
        const liveYear = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        const historicalYear = liveYear - 1;
        useSettingsStore.getState()._hydrate(
            { ...DEFAULT_BELGIAN_TAX_PROFILE, grossAnnualIncome: 60_000 },
            {
                [historicalYear]: {
                    ...DEFAULT_BELGIAN_TAX_PROFILE,
                    taxYear: historicalYear,
                    grossAnnualIncome: 45_000,
                },
            },
            {},
        );
        useSettingsStore.getState().freezeCalculation(historicalYear);

        const state = useSettingsStore.getState();
        expect(resolveBelgianTaxProfile(state, liveYear)).toBe(state.profile);
        expect(
            resolveBelgianTaxProfile(state, historicalYear).grossAnnualIncome,
        ).toBe(45_000);
        expect(resolveBelgianTaxCalculation(state, historicalYear)).toBe(
            state.snapshotMetas[historicalYear].frozenCalculation,
        );
    });
});
