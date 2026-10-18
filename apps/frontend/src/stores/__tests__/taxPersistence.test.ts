import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "../belgianTaxStore";
import * as runtime from "@/lib/belgianTax/householdRuntime";
import { useSettingsStore } from "../settingsStore";
import { persistTaxFiling, scheduleTaxPersistence } from "../taxPersistence";

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("preserves other-year and live-household edits made during filing, including their next persisted payload", async () => {
    vi.useFakeTimers();
    let acknowledge!: () => void;
    const save = vi
        .spyOn(apiClient, "saveSettings")
        .mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    acknowledge = resolve;
                }),
        )
        .mockResolvedValue(undefined);
    const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
    useSettingsStore
        .getState()
        ._hydrate(
            runtime,
            runtime.upgradeProfileV1ToHousehold({
                ...DEFAULT_BELGIAN_TAX_PROFILE,
                profileConfigured: true,
                grossAnnualIncome: 40000,
            }),
            {},
            {},
        );
    useSettingsStore.getState().createSnapshotFromLive(year - 1);
    const filing = persistTaxFiling(year, "synthetic-confirmation");
    expect(useSettingsStore.getState().isYearFiled(year)).toBe(false);
    useSettingsStore
        .getState()
        .updateSnapshot(year - 1, { grossAnnualIncome: 50000 });
    useSettingsStore.getState().createSnapshotFromLive(year - 2);
    useSettingsStore.getState().updateProfile({ grossAnnualIncome: 60000 });
    scheduleTaxPersistence(useSettingsStore.getState());
    acknowledge();
    await filing;
    const state = useSettingsStore.getState();
    expect(state.profile.grossAnnualIncome).toBe(60000);
    expect(state.snapshots[year - 1]?.grossAnnualIncome).toBe(50000);
    expect(state.snapshots[year - 2]?.grossAnnualIncome).toBe(40000);
    expect(state.snapshots[year]?.grossAnnualIncome).toBe(40000);
    expect(state.getFrozenCalculation(year)?.grossIncome).toBe(40000);
    expect(state.isYearFiled(year)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0]).toEqual({
        belgian_tax_household_v2: state.household,
        belgian_tax_household_snapshots_v2: state.householdSnapshots,
        belgian_tax_profile_snapshot_meta_v1: state.snapshotMetas,
    });
});
