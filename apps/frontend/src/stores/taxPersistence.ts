import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import {
    buildFiledTaxState,
    publishFiledYear,
    type BelgianTaxSlice,
} from "./belgianTaxStore";
import { useSettingsStore } from "./settingsStore";

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Record<string, unknown> | undefined;
let filingInFlight = false;
// The household (v2) keys are the stored source of truth (ADR-200); v1 keys are read only.
function payload(
    state: Pick<
        BelgianTaxSlice,
        "household" | "householdSnapshots" | "snapshotMetas"
    >,
) {
    return {
        belgian_tax_household_v2: state.household,
        belgian_tax_household_snapshots_v2: state.householdSnapshots,
        belgian_tax_profile_snapshot_meta_v1: state.snapshotMetas,
    };
}
function reportFailure(error: unknown) {
    logger.error("Failed to save Belgian tax settings:", error);
    useSettingsStore.getState()._markSaveError();
}
export function scheduleTaxPersistence(state: BelgianTaxSlice) {
    // After a failed engine load nothing was hydrated, so nothing may be written back.
    if (state.isLoading || state.householdLoadFailed || !state.household)
        return;
    const values = payload(state);
    pending = values;
    clearTimeout(timer);
    if (filingInFlight) return;
    timer = setTimeout(() => {
        const values = pending;
        pending = undefined;
        if (!values) return;
        void apiClient.saveSettings(values).catch(reportFailure);
    }, 500);
}

/** Only expose Filed after the household, snapshot and frozen metadata commit together. */
export async function persistTaxFiling(year: number, reference?: string) {
    if (filingInFlight) throw new Error("A filing save is already in progress");
    const state = useSettingsStore.getState();
    if (state.isLoading) throw new Error("Tax settings are still loading");
    const update = buildFiledTaxState(state, year, reference);
    if (update === state) throw new Error("This tax year is not ready to file");
    const filedMeta = update.snapshotMetas?.[year];
    if (!filedMeta) throw new Error("The filing record is missing");
    const filedHousehold = update.householdSnapshots?.[year];
    const values = payload({ ...state, ...update });
    clearTimeout(timer);
    pending = undefined;
    filingInFlight = true;
    try {
        await apiClient.saveSettings(values);
        // Apply only the confirmed filing. Other years and the live household
        // may have been edited while this request waited for acknowledgment.
        useSettingsStore.setState((current) =>
            publishFiledYear(current, year, filedHousehold, filedMeta),
        );
    } catch (error) {
        reportFailure(error);
        throw error;
    } finally {
        filingInFlight = false;
        if (pending) scheduleTaxPersistence(useSettingsStore.getState());
    }
}
