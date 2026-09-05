/**
 * Compatibility boundary for Belgian-tax settings.
 *
 * Persisted domain state and actions live in the Belgian-tax slice of settingsStore.
 * This provider only hydrates/persists that slice and keeps the existing provider-scope
 * contract. New consumers should pass a narrow selector to useBelgianTaxProfile.
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
import type {
    BelgianTaxProfile,
    BelgianTaxProfileSnapshotMetas,
    BelgianTaxProfileSnapshots,
} from "@/lib/belgianTax";

const PROFILE_SETTINGS_KEY = "belgian_tax_profile";
const SNAPSHOTS_SETTINGS_KEY = "belgian_tax_profile_snapshots_v1";
const SNAPSHOT_METAS_SETTINGS_KEY = "belgian_tax_profile_snapshot_meta_v1";

const BelgianTaxProfileScope = createContext(false);

type PublicBelgianTaxProfileState = Omit<
    BelgianTaxSlice,
    "_hydrate" | "_beginHydration" | "_markSaveError"
>;

const selectPublicState = (
    state: SettingsStore,
): PublicBelgianTaxProfileState => ({
    profile: state.profile,
    calculation: state.calculation,
    snapshots: state.snapshots,
    snapshotMetas: state.snapshotMetas,
    viewedYear: state.viewedYear,
    isViewingHistorical: state.isViewingHistorical,
    isLoading: state.isLoading,
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
        usePreloadedSetting<BelgianTaxProfileSnapshots>(SNAPSHOTS_SETTINGS_KEY);
    const { value: preloadedMetas, isLoading: preloadMetasLoading } =
        usePreloadedSetting<BelgianTaxProfileSnapshotMetas>(
            SNAPSHOT_METAS_SETTINGS_KEY,
        );
    const hydrate = useSettingsStore((state) => state._hydrate);
    const beginHydration = useSettingsStore((state) => state._beginHydration);
    const markSaveError = useSettingsStore((state) => state._markSaveError);
    const profile = useSettingsStore((state) => state.profile);
    const snapshots = useSettingsStore((state) => state.snapshots);
    const snapshotMetas = useSettingsStore((state) => state.snapshotMetas);
    const isLoading = useSettingsStore((state) => state.isLoading);

    useEffect(() => beginHydration(), [beginHydration]);

    useEffect(() => {
        if (
            preloadProfileLoading ||
            preloadSnapshotsLoading ||
            preloadMetasLoading
        )
            return;
        const mergedProfile = {
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            ...(preloadedProfile ?? {}),
        };
        hydrate(
            {
                ...mergedProfile,
                profileConfigured: hasMeaningfulBelgianTaxData(mergedProfile),
            },
            preloadedSnapshots ?? {},
            preloadedMetas ?? {},
        );
    }, [
        hydrate,
        preloadedMetas,
        preloadMetasLoading,
        preloadedProfile,
        preloadProfileLoading,
        preloadedSnapshots,
        preloadSnapshotsLoading,
    ]);

    useDebouncedSetting(
        PROFILE_SETTINGS_KEY,
        profile,
        isLoading,
        markSaveError,
        "Failed to save Belgian tax profile:",
    );
    useDebouncedSetting(
        SNAPSHOTS_SETTINGS_KEY,
        snapshots,
        isLoading,
        markSaveError,
        "Failed to save Belgian tax profile snapshots:",
    );
    useDebouncedSetting(
        SNAPSHOT_METAS_SETTINGS_KEY,
        snapshotMetas,
        isLoading,
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
// eslint-disable-next-line react-refresh/only-export-components
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
