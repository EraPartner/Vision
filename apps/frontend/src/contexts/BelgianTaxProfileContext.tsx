/**
 * Compatibility boundary for Belgian-tax settings.
 *
 * Persisted domain state and actions live in the Belgian-tax slice of settingsStore.
 * This provider only hydrates/persists that slice and keeps the existing provider-scope
 * contract. The household (v2) keys are the stored source of truth; on first load the v1
 * keys are upgraded and the v2 keys written (ADR-200). New consumers should pass a narrow selector to useBelgianTaxProfile.
 */
import {
    createContext,
    useContext,
    useEffect,
    useRef,
    type ReactNode,
} from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { usePreloadedSetting } from "@/contexts/SettingsPreloadContext";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
    DEFAULT_BELGIAN_TAX_PROFILE,
    hasMeaningfulBelgianTaxData,
    type BelgianTaxSlice,
} from "@/stores/belgianTaxStore";
import { useSettingsStore, type SettingsStore } from "@/stores/settingsStore";
import { apiClient } from "@/lib/api";
import logger from "@/lib/logger";
import { loadHouseholdRuntime } from "@/lib/belgianTax/loadHouseholdRuntime";
import type {
    BelgianTaxProfile,
    BelgianTaxProfileSnapshotMetas,
} from "@/lib/belgianTax";

// v1 keys are read only, as the source of the one-time upgrade (ADR-200). No backend
// consumer reads them, so they are no longer written.
const PROFILE_SETTINGS_KEY = "belgian_tax_profile";
const SNAPSHOTS_SETTINGS_KEY = "belgian_tax_profile_snapshots_v1";
const HOUSEHOLD_SETTINGS_KEY = "belgian_tax_household_v2";
const HOUSEHOLD_SNAPSHOTS_SETTINGS_KEY = "belgian_tax_household_snapshots_v2";
const SNAPSHOT_METAS_SETTINGS_KEY = "belgian_tax_profile_snapshot_meta_v1";

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
    householdResult: state.householdResult,
    profile: state.profile,
    calculation: state.calculation,
    snapshots: state.snapshots,
    snapshotMetas: state.snapshotMetas,
    viewedYear: state.viewedYear,
    isViewingHistorical: state.isViewingHistorical,
    isLoading: state.isLoading,
    storedHouseholdUnreadable: state.storedHouseholdUnreadable,
    householdLoadFailed: state.householdLoadFailed,
    saveErrorNonce: state.saveErrorNonce,
    updateProfile: state.updateProfile,
    resetProfile: state.resetProfile,
    setViewedYear: state.setViewedYear,
    snapshotExistsForYear: state.snapshotExistsForYear,
    profileForYear: state.profileForYear,
    calculationForYear: state.calculationForYear,
    displayCalculationForYear: state.displayCalculationForYear,
    createSnapshotFromLive: state.createSnapshotFromLive,
    updateSnapshot: state.updateSnapshot,
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
    const { value: preloadedProfile, isLoading: preloadProfileLoading } =
        usePreloadedSetting<BelgianTaxProfile>(PROFILE_SETTINGS_KEY);
    const { value: preloadedSnapshots, isLoading: preloadSnapshotsLoading } =
        usePreloadedSetting<unknown>(SNAPSHOTS_SETTINGS_KEY);
    const { value: preloadedHousehold, isLoading: preloadHouseholdLoading } =
        usePreloadedSetting<unknown>(HOUSEHOLD_SETTINGS_KEY);
    const {
        value: preloadedHouseholdSnapshots,
        isLoading: preloadHouseholdSnapshotsLoading,
    } = usePreloadedSetting<unknown>(HOUSEHOLD_SNAPSHOTS_SETTINGS_KEY);
    const { value: preloadedMetas, isLoading: preloadMetasLoading } =
        usePreloadedSetting<BelgianTaxProfileSnapshotMetas>(
            SNAPSHOT_METAS_SETTINGS_KEY,
        );
    const hydrate = useSettingsStore((state) => state._hydrate);
    const beginHydration = useSettingsStore((state) => state._beginHydration);
    const markSaveError = useSettingsStore((state) => state._markSaveError);
    const markHydrationFailed = useSettingsStore(
        (state) => state._markHydrationFailed,
    );
    const household = useSettingsStore((state) => state.household);
    const householdSnapshots = useSettingsStore(
        (state) => state.householdSnapshots,
    );
    const snapshotMetas = useSettingsStore((state) => state.snapshotMetas);
    // After a failed engine load nothing was hydrated, so nothing may be written back.
    const persistBlocked = useSettingsStore(
        (state) => state.isLoading || state.householdLoadFailed,
    );

    useEffect(() => beginHydration(), [beginHydration]);

    useEffect(() => {
        if (
            preloadProfileLoading ||
            preloadSnapshotsLoading ||
            preloadHouseholdLoading ||
            preloadHouseholdSnapshotsLoading ||
            preloadMetasLoading
        )
            return;
        let cancelled = false;
        // The household engine and its zod schemas load on demand to keep them out of the
        // boot bundle (ADR-200); the import is retried once.
        void loadHouseholdRuntime()
            .then((runtime) => {
                if (cancelled) return;
                const mergedProfile = {
                    ...DEFAULT_BELGIAN_TAX_PROFILE,
                    ...(preloadedProfile ?? {}),
                };
                const loaded = runtime.loadHouseholdSettings({
                    defaultsV1: DEFAULT_BELGIAN_TAX_PROFILE,
                    profileV1: {
                        ...mergedProfile,
                        profileConfigured:
                            hasMeaningfulBelgianTaxData(mergedProfile),
                    },
                    hasProfileV1: preloadedProfile != null,
                    snapshotsV1: preloadedSnapshots,
                    householdV2: preloadedHousehold,
                    snapshotsV2: preloadedHouseholdSnapshots,
                });
                for (const warning of loaded.warnings) {
                    logger.warn(
                        warning.kind === "invalid_stored"
                            ? "Invalid Belgian tax household setting; using the v1 upgrade instead"
                            : "Upgraded Belgian tax household setting is invalid; keeping it unsaved",
                        warning,
                    );
                }
                let liveHousehold = loaded.household;
                if (
                    !liveHousehold.profileConfigured &&
                    hasMeaningfulBelgianTaxData(
                        runtime.projectHouseholdToProfileV1(liveHousehold),
                    )
                ) {
                    liveHousehold = {
                        ...liveHousehold,
                        profileConfigured: true,
                    };
                }
                hydrate(
                    runtime,
                    liveHousehold,
                    loaded.snapshots,
                    preloadedMetas ?? {},
                    loaded.storedValueInvalid,
                );
                // First load after the upgrade: persist the v2 keys now (no confirmation, v1 kept).
                const save = (key: string, value: unknown, message: string) =>
                    apiClient.saveSetting(key, value).catch((err: unknown) => {
                        logger.error(message, err);
                        markSaveError();
                    });
                if (loaded.writeHousehold)
                    void save(
                        HOUSEHOLD_SETTINGS_KEY,
                        liveHousehold,
                        "Failed to save the upgraded Belgian tax household:",
                    );
                if (loaded.writeSnapshots)
                    void save(
                        HOUSEHOLD_SNAPSHOTS_SETTINGS_KEY,
                        loaded.snapshots,
                        "Failed to save the upgraded Belgian tax household snapshots:",
                    );
            })
            .catch((err: unknown) => {
                logger.error(
                    "Failed to load the Belgian tax household engine:",
                    err,
                );
                if (!cancelled) markHydrationFailed();
            });
        return () => {
            cancelled = true;
        };
    }, [
        hydrate,
        markHydrationFailed,
        markSaveError,
        preloadedHousehold,
        preloadHouseholdLoading,
        preloadedHouseholdSnapshots,
        preloadHouseholdSnapshotsLoading,
        preloadedMetas,
        preloadMetasLoading,
        preloadedProfile,
        preloadProfileLoading,
        preloadedSnapshots,
        preloadSnapshotsLoading,
    ]);

    useDebouncedSetting(
        HOUSEHOLD_SETTINGS_KEY,
        household,
        persistBlocked,
        markSaveError,
        "Failed to save Belgian tax household:",
    );
    useDebouncedSetting(
        HOUSEHOLD_SNAPSHOTS_SETTINGS_KEY,
        householdSnapshots,
        persistBlocked,
        markSaveError,
        "Failed to save Belgian tax household snapshots:",
    );
    useDebouncedSetting(
        SNAPSHOT_METAS_SETTINGS_KEY,
        snapshotMetas,
        persistBlocked,
        markSaveError,
        "Failed to save Belgian tax profile snapshot meta:",
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
