import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/api";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "../belgianTaxStore";
import * as runtime from "@/lib/belgianTax/householdRuntime";
import { upgradeProfileV1ToHousehold } from "@/lib/belgianTax/householdMigration";
import { useSettingsStore } from "../settingsStore";
import {
    onTaxSettingsSaved,
    persistTaxFiling,
    scheduleTaxPersistence,
} from "../taxPersistence";

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("preserves other-year and live-household edits made during filing, including their next persisted payload", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
            upgradeProfileV1ToHousehold({
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
    // The filing saves once the server has computed the figures it freezes.
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
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

it("notifies saved-listeners only after the debounced save is acknowledged", async () => {
    vi.useFakeTimers();
    let acknowledge!: () => void;
    vi.spyOn(apiClient, "saveSettings").mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                acknowledge = resolve;
            }),
    );
    useSettingsStore
        .getState()
        ._hydrate(
            runtime,
            upgradeProfileV1ToHousehold({
                ...DEFAULT_BELGIAN_TAX_PROFILE,
                profileConfigured: true,
                grossAnnualIncome: 40000,
            }),
            {},
            {},
        );
    const saved = vi.fn();
    const unsubscribe = onTaxSettingsSaved(saved);
    useSettingsStore.getState().updateProfile({ grossAnnualIncome: 45000 });
    scheduleTaxPersistence(useSettingsStore.getState());
    await vi.advanceTimersByTimeAsync(500);
    expect(saved).not.toHaveBeenCalled();
    acknowledge();
    await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    unsubscribe();
});

it("does not notify saved-listeners when the save fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(apiClient, "saveSettings").mockRejectedValueOnce(
        new Error("conflict"),
    );
    const saved = vi.fn();
    const unsubscribe = onTaxSettingsSaved(saved);
    useSettingsStore.getState().updateProfile({ grossAnnualIncome: 47000 });
    scheduleTaxPersistence(useSettingsStore.getState());
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(saved).not.toHaveBeenCalled();
    unsubscribe();
});
