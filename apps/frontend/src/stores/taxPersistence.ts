import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import { buildFiledTaxState, type BelgianTaxSlice } from "./belgianTaxStore";
import { useSettingsStore } from "./settingsStore";

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Record<string, unknown> | undefined;
let filingInFlight = false;
function payload(
    state: Pick<BelgianTaxSlice, "profile" | "snapshots" | "snapshotMetas">,
) {
    return {
        belgian_tax_profile: state.profile,
        belgian_tax_profile_snapshots_v1: state.snapshots,
        belgian_tax_profile_snapshot_meta_v1: state.snapshotMetas,
    };
}
function reportFailure(error: unknown) {
    logger.error("Failed to save Belgian tax settings:", error);
    useSettingsStore.getState()._markSaveError();
}
export function scheduleTaxPersistence(state: BelgianTaxSlice) {
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

/** Only expose Filed after the profile, snapshot and frozen metadata commit together. */
export async function persistTaxFiling(year: number, reference?: string) {
    if (filingInFlight) throw new Error("A filing save is already in progress");
    const state = useSettingsStore.getState();
    if (state.isLoading) throw new Error("Tax settings are still loading");
    const update = buildFiledTaxState(state, year, reference);
    if (update === state) throw new Error("This tax year is not ready to file");
    const filedSnapshot = update.snapshots?.[year];
    const filedMeta = update.snapshotMetas?.[year];
    if (!filedSnapshot || !filedMeta)
        throw new Error("The filing snapshot is missing");
    const values = payload({ ...state, ...update });
    clearTimeout(timer);
    pending = undefined;
    filingInFlight = true;
    try {
        await apiClient.saveSettings(values);
        // Apply only the confirmed filing. Other years and the live profile
        // may have been edited while this request waited for acknowledgment.
        useSettingsStore.setState((current) => ({
            snapshots: { ...current.snapshots, [year]: filedSnapshot },
            snapshotMetas: {
                ...current.snapshotMetas,
                [year]: filedMeta,
            },
        }));
    } catch (error) {
        reportFailure(error);
        throw error;
    } finally {
        filingInFlight = false;
        if (pending) scheduleTaxPersistence(useSettingsStore.getState());
    }
}
