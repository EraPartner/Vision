import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import {
    buildFiledTaxState,
    computeTaxYearResults,
    isTaxYearFileable,
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
const savedListeners = new Set<() => void>();
/**
 * Subscribe to acknowledged Belgian-tax settings saves, so server-computed views
 * (the tax dashboards) refetch once the household they read has been stored.
 * Returns the unsubscribe function.
 */
export function onTaxSettingsSaved(listener: () => void): () => void {
    savedListeners.add(listener);
    return () => {
        savedListeners.delete(listener);
    };
}
function notifySaved() {
    for (const listener of savedListeners) listener();
}
function reportFailure(error: unknown) {
    logger.error("Failed to save Belgian tax settings:", error);
    useSettingsStore.getState()._markSaveError();
}
export function scheduleTaxPersistence(state: BelgianTaxSlice) {
    // After a failed load nothing was hydrated, so nothing may be written back.
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
        void apiClient
            .saveSettings(values)
            .then(notifySaved, reportFailure);
    }, 500);
}

/**
 * Only expose Filed after the household, snapshot and frozen metadata commit together. A year
 * that is not frozen yet is filed with the server's figures for its household, computed first.
 */
export async function persistTaxFiling(year: number, reference?: string) {
    if (filingInFlight) throw new Error("A filing save is already in progress");
    const state = useSettingsStore.getState();
    if (state.isLoading) throw new Error("Tax settings are still loading");
    if (!isTaxYearFileable(state, year))
        throw new Error("This tax year is not ready to file");
    // The filing payload carries every edit made so far; edits made while the figures are
    // computed or saved stay pending and are saved after it.
    filingInFlight = true;
    clearTimeout(timer);
    const hadPending = pending !== undefined;
    pending = undefined;
    let saveSent = false;
    try {
        const computed = state.snapshotMetas[year]?.frozenCalculation
            ? undefined
            : await computeTaxYearResults(state, year);
        const update = buildFiledTaxState(state, year, reference, computed);
        if (update === state)
            throw new Error("This tax year is not ready to file");
        const filedMeta = update.snapshotMetas?.[year];
        if (!filedMeta) throw new Error("The filing record is missing");
        const filedHousehold = update.householdSnapshots?.[year];
        const values = payload({ ...state, ...update });
        saveSent = true;
        await apiClient.saveSettings(values);
        // Apply only the confirmed filing. Other years and the live household
        // may have been edited while this request waited for acknowledgment.
        useSettingsStore.setState((current) =>
            publishFiledYear(current, year, filedHousehold, filedMeta),
        );
        notifySaved();
    } catch (error) {
        reportFailure(error);
        throw error;
    } finally {
        filingInFlight = false;
        // Edits the filing payload would have carried are saved on their own when it never left.
        // `pending` may have been set by edits made while this function awaited.
        if (pending !== undefined || (hadPending && !saveSent))
            scheduleTaxPersistence(useSettingsStore.getState());
    }
}
