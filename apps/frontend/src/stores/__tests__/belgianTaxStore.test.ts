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
        expect(state.snapshots[year]?.grossAnnualIncome).toBe(50_000);
        expect(
            state.snapshotMetas[year]?.history?.map((entry) => entry.kind),
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
            state.snapshotMetas[historicalYear]!.frozenCalculation,
        );
    });
    it("records the configured live year and preserves its frozen record across reload and unfiling", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        useSettingsStore
            .getState()
            .updateProfile({
                profileConfigured: true,
                grossAnnualIncome: 50_000,
            });
        useSettingsStore.getState().freezeCalculation(year);
        const frozen = useSettingsStore.getState().getFrozenCalculation(year);
        useSettingsStore
            .getState()
            .markYearAsFiled(year, "synthetic-reference");
        const saved = useSettingsStore.getState();
        expect(saved.snapshots[year]?.grossAnnualIncome).toBe(50_000);
        expect(saved.snapshotMetas[year]?.filing?.reference).toBe(
            "synthetic-reference",
        );
        useSettingsStore
            .getState()
            ._hydrate(saved.profile, saved.snapshots, saved.snapshotMetas);
        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 60_000 });
        expect(useSettingsStore.getState().getFrozenCalculation(year)).toEqual(
            frozen,
        );
        useSettingsStore.getState().unmarkYearAsFiled(year);
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(false);
        expect(useSettingsStore.getState().getFrozenCalculation(year)).toEqual(
            frozen,
        );
        expect(
            useSettingsStore
                .getState()
                .getSnapshotHistory(year)
                .map((e) => e.kind),
        ).toEqual(["frozen", "filed", "unfiled"]);
    });

    it("requires a reviewed profile for historical filing instead of freezing a live-profile estimate", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        useSettingsStore.getState().updateProfile({ profileConfigured: true });
        useSettingsStore.getState().markYearAsFiled(year);
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(false);
        useSettingsStore.getState().createSnapshotFromLive(year);
        useSettingsStore.getState().markYearAsFiled(year);
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(true);
    });
});
