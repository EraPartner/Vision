/**
 * Compatibility boundary for Belgian-tax settings.
 *
 * Persisted domain state and actions live in the Belgian-tax slice of settingsStore.
 * This provider only hydrates/persists that slice and keeps the existing provider-scope
 * contract. It hydrates from GET /api/belgian-tax/overview, which runs the v1→v2 upgrade
 * on the server (ADR-200) and returns the CAS baselines of the stored keys from the same
 * read; when the upgrade has not been stored yet the provider writes the v2 keys once.
 * No tax is computed in the browser. New consumers should pass a narrow selector to
 * useBelgianTaxProfile.
 */
import {
    createContext,
    useContext,
    useEffect,
    useRef,
    type ReactNode,
} from "react";
import { toast } from "sonner";
import { useShallow } from "@/stores/createStore";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { scheduleTaxPersistence } from "@/stores/taxPersistence";
import type { BelgianTaxSlice } from "@/stores/belgianTaxStore";
import { useSettingsStore, type SettingsStore } from "@/stores/settingsStore";
import { apiClient } from "@/lib/api";
import { adoptSettingBaselines } from "@/lib/api/settings";
import { getBelgianTaxOverview } from "@/lib/api/belgianTax";
import logger from "@/lib/logger";
import { loadHouseholdRuntime } from "@/lib/belgianTax/loadHouseholdRuntime";

const HOUSEHOLD_SETTINGS_KEY = "belgian_tax_household_v2";
const HOUSEHOLD_SNAPSHOTS_SETTINGS_KEY = "belgian_tax_household_snapshots_v2";

const BelgianTaxProfileScope = createContext(false);

type PublicBelgianTaxProfileState = Omit<
    BelgianTaxSlice,
    "_hydrate" | "_beginHydration" | "_markHydrationFailed" | "_markSaveError"
>;

const selectPublicState = (
    state: SettingsStore,
): PublicBelgianTaxProfileState => ({
    household: state.household,
    householdSnapshots: state.householdSnapshots,
    hydratedComputation: state.hydratedComputation,
    profile: state.profile,
    snapshots: state.snapshots,
    snapshotMetas: state.snapshotMetas,
    viewedYear: state.viewedYear,
    isViewingHistorical: state.isViewingHistorical,
    isLoading: state.isLoading,
    storedHouseholdUnreadable: state.storedHouseholdUnreadable,
    householdLoadFailed: state.householdLoadFailed,
    saveErrorNonce: state.saveErrorNonce,
    updateProfile: state.updateProfile,
    updateHousehold: state.updateHousehold,
    resetProfile: state.resetProfile,
    setViewedYear: state.setViewedYear,
    snapshotExistsForYear: state.snapshotExistsForYear,
    profileForYear: state.profileForYear,
    createSnapshotFromLive: state.createSnapshotFromLive,
    updateSnapshot: state.updateSnapshot,
    updateHouseholdSnapshot: state.updateHouseholdSnapshot,
    metaForYear: state.metaForYear,
    isYearFiled: state.isYearFiled,
    getFrozenCalculation: state.getFrozenCalculation,
    getSnapshotHistory: state.getSnapshotHistory,
    freezeCalculation: state.freezeCalculation,
    unfreezeCalculation: state.unfreezeCalculation,
    markYearAsFiled: state.markYearAsFiled,
    unmarkYearAsFiled: state.unmarkYearAsFiled,
});

export function BelgianTaxProfileProvider({
    children,
}: {
    children: ReactNode;
}) {
    const hydrate = useSettingsStore((state) => state._hydrate);
    const beginHydration = useSettingsStore((state) => state._beginHydration);
    const markSaveError = useSettingsStore((state) => state._markSaveError);
    const markHydrationFailed = useSettingsStore(
        (state) => state._markHydrationFailed,
    );

    useEffect(() => beginHydration(), [beginHydration]);

    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        // The household helpers and their zod schemas load on demand to keep them out of the
        // boot bundle (ADR-200); the import is retried once.
        void Promise.all([
            loadHouseholdRuntime(),
            getBelgianTaxOverview(undefined, controller.signal),
        ])
            .then(([runtime, overview]) => {
                if (cancelled) return;
                // Later saves compare against the stored values this tab now shows.
                adoptSettingBaselines(overview.records);
                for (const warning of overview.warnings) {
                    logger.warn(
                        warning.kind === "invalid_stored"
                            ? "Invalid Belgian tax household setting; using the v1 upgrade instead"
                            : "Upgraded Belgian tax household setting is invalid; keeping it unsaved",
                        warning,
                    );
                }
                const live = overview.liveHousehold;
                // The overview's figures belong to the live household unless that year is frozen.
                const liveFiguresComputed =
                    overview.year === live.taxYear &&
                    overview.calculationSource === "computed" &&
                    overview.householdResultSource === "computed";
                hydrate(
                    runtime,
                    live,
                    overview.householdSnapshots,
                    overview.snapshotMetas,
                    overview.storedValueInvalid,
                    liveFiguresComputed
                        ? {
                              household: live,
                              computation: {
                                  calculation: overview.calculation,
                                  result: overview.result,
                              },
                          }
                        : null,
                );
                // First load after the upgrade: persist the v2 keys now (no confirmation, v1 kept).
                const save = (key: string, value: unknown, message: string) =>
                    apiClient.saveSetting(key, value).catch((err: unknown) => {
                        logger.error(message, err);
                        markSaveError();
                    });
                if (overview.householdMigrationNeeded)
                    void save(
                        HOUSEHOLD_SETTINGS_KEY,
                        live,
                        "Failed to save the upgraded Belgian tax household:",
                    );
                if (overview.snapshotsMigrationNeeded)
                    void save(
                        HOUSEHOLD_SNAPSHOTS_SETTINGS_KEY,
                        overview.householdSnapshots,
                        "Failed to save the upgraded Belgian tax household snapshots:",
                    );
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                logger.error("Failed to load the Belgian tax household:", err);
                markHydrationFailed();
            });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [hydrate, markHydrationFailed, markSaveError]);

    useEffect(
        () =>
            useSettingsStore.subscribe((state, previous) => {
                // After a failed load nothing was hydrated, so nothing may be written back.
                if (
                    state.isLoading ||
                    previous.isLoading ||
                    state.householdLoadFailed ||
                    !state.household
                )
                    return;
                if (
                    state.household !== previous.household ||
                    state.householdSnapshots !== previous.householdSnapshots ||
                    state.snapshotMetas !== previous.snapshotMetas
                ) {
                    scheduleTaxPersistence(state);
                }
            }),
        [],
    );

    return (
        <BelgianTaxProfileScope.Provider value>
            {children}
        </BelgianTaxProfileScope.Provider>
    );
}

export function BelgianTaxSaveErrorToaster() {
    const { t } = useLanguage();
    const saveErrorNonce = useBelgianTaxProfile(
        (state) => state.saveErrorNonce,
    );
    const lastSeen = useRef(saveErrorNonce);
    useEffect(() => {
        if (saveErrorNonce !== lastSeen.current) {
            lastSeen.current = saveErrorNonce;
            if (saveErrorNonce > 0) toast.error(t("settings.saveFailed"));
        }
    }, [saveErrorNonce, t]);
    return null;
}

// Compatibility hook stays beside its provider, matching the other hydration bridges.
export function useBelgianTaxProfile(): PublicBelgianTaxProfileState;
export function useBelgianTaxProfile<T>(
    selector: (state: PublicBelgianTaxProfileState) => T,
): T;
// eslint-disable-next-line react-refresh/only-export-components
export function useBelgianTaxProfile<T = PublicBelgianTaxProfileState>(
    selector?: (state: PublicBelgianTaxProfileState) => T,
): T {
    if (!useContext(BelgianTaxProfileScope)) {
        throw new Error(
            "useBelgianTaxProfile must be used within BelgianTaxProfileProvider",
        );
    }
    return useSettingsStore(
        useShallow((state) =>
            selector
                ? selector(selectPublicState(state))
                : (selectPublicState(state) as T),
        ),
    );
}
