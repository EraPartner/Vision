/**
 * BelgianTaxProfileContext
 *
 * Stores and persists the user's Belgian tax profile + frozen per-year snapshots and exposes
 * the derived PIT calculation.
 *
 * Pure tax logic lives in `@/lib/belgianTax`. This file only owns React state, persistence,
 * and the context wiring.
 *
 * Two distinct year concepts coexist here:
 *  - `profile.taxYear` — the income year the user's *editable, active* profile belongs to.
 *    Advances at most once per income year; on advance, the outgoing profile is archived to
 *    `snapshots[oldYear]` automatically.
 *  - `viewedYear` — the income year the UI is currently displaying. Transient, never
 *    persisted. May point at a past snapshot (read-only by default, see warning banner) or
 *    at a year with only transaction data and no saved snapshot.
 */
import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useRef,
    useMemo,
    type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useLanguage } from '@/contexts/LanguageContext';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';
import { useDebouncedSetting } from '@/hooks/useDebouncedSetting';
import {
    computeBelgianPIT,
    LATEST_TAX_YEAR,
    type BelgianTaxProfile,
    type BelgianTaxProfileSnapshots,
    type BelgianTaxProfileSnapshotMeta,
    type BelgianTaxProfileSnapshotMetas,
    type BelgianTaxCalculation,
    type SnapshotAuditEntry,
    type SnapshotAuditEntryKind,
} from '@/lib/belgianTax';

// Re-export the public surface so consumers can keep importing from this path.
export type {
    BelgianTaxProfile,
    BelgianTaxProfileSnapshots,
    BelgianTaxProfileSnapshotMeta,
    BelgianTaxProfileSnapshotMetas,
    BelgianTaxCalculation,
    SnapshotAuditEntry,
    SnapshotAuditEntryKind,
    FilingRecord,
    EmploymentType,
    BelgianRegion,
    ProfessionalExpenseMethod,
    PensionScheme,
} from '@/lib/belgianTax';
/* eslint-disable react-refresh/only-export-components */
export {
    computeBelgianPIT,
    BELGIAN_TAX_BRACKETS,
    EMPLOYEE_SS_RATE,
    LUMP_SUM_PROFESSIONAL_EXPENSE_RATE,
    LUMP_SUM_PROFESSIONAL_EXPENSE_CAP,
    DIRECTOR_PROFESSIONAL_EXPENSE_RATE,
    DIRECTOR_PROFESSIONAL_EXPENSE_CAP,
    BASIC_PERSONAL_EXEMPTION,
    DEPENDENT_CHILD_EXEMPTION_INCREASES,
    EXTRA_CHILD_EXEMPTION_FROM_FIFTH,
    OTHER_DEPENDENT_EXEMPTION,
    PENSION_SAVINGS_CAP_STANDARD,
    PENSION_SAVINGS_CAP_ALTERNATIVE,
    LIFE_INSURANCE_CAP,
    CHARITABLE_DONATION_MIN,
    CHILDCARE_DAILY_CAP,
    CHILDCARE_DAILY_CAP_2025,
    BELGIAN_DIVIDEND_EXEMPTION,
    BELGIAN_DIVIDEND_WHT_RATE,
    DEFAULT_COMMUNAL_SURCHARGE,
    SUPPORTED_TAX_YEARS,
    LATEST_TAX_YEAR,
    getTaxTable,
} from '@/lib/belgianTax';
/* eslint-enable react-refresh/only-export-components */

interface BelgianTaxProfileContextType {
    /** Editable live profile. Always represents the active income year. */
    profile: BelgianTaxProfile;
    updateProfile: (updates: Partial<BelgianTaxProfile>) => void;
    resetProfile: () => void;
    /** PIT calculation for the live profile (i.e. the active year). */
    calculation: BelgianTaxCalculation;
    isLoading: boolean;
    /**
     * Bumped whenever a debounced persist fails. The provider mounts above
     * LanguageProvider so it cannot toast a translated message itself;
     * BelgianTaxSaveErrorToaster (mounted under it) watches this nonce.
     */
    saveErrorNonce: number;
    /** Frozen per-year profile snapshots, keyed by income year. */
    snapshots: BelgianTaxProfileSnapshots;
    /** Per-year meta (filing status, frozen calc, audit history). Sparse — only present for years touched by file/freeze/edit. */
    snapshotMetas: BelgianTaxProfileSnapshotMetas;
    /** The income year currently being displayed by the UI. Defaults to `profile.taxYear`. */
    viewedYear: number;
    setViewedYear: (year: number) => void;
    /** True when `viewedYear` is not the live profile's year. */
    isViewingHistorical: boolean;
    /** Returns the snapshot for a year, or `null` if none exists. */
    snapshotExistsForYear: (year: number) => boolean;
    /**
     * Resolve the profile to use for a given income year:
     *  - `year === profile.taxYear` → returns the live profile.
     *  - snapshot exists → returns the snapshot.
     *  - otherwise → returns the live profile with `taxYear` overridden (estimate mode).
     */
    profileForYear: (year: number) => BelgianTaxProfile;
    /** Live-recompute the PIT calculation for a given year using `profileForYear`. */
    calculationForYear: (year: number) => BelgianTaxCalculation;
    /**
     * Calculation to display for a given year: returns the frozen "as-filed" calc when one
     * exists, otherwise falls back to `calculationForYear`. Use this on read sites that
     * should respect engine-drift protection (charts, summary cards, comparison views).
     */
    displayCalculationForYear: (year: number) => BelgianTaxCalculation;
    /**
     * Seed a snapshot for a year by cloning the current live profile (with `taxYear`
     * overridden). No-op if a snapshot already exists for that year. Appends a `'created'`
     * entry to the meta history.
     */
    createSnapshotFromLive: (year: number) => void;
    /** Patch a snapshot in place. Used by the dialog's historical-edit mode. Appends `'patched'`. */
    updateSnapshot: (year: number, updates: Partial<BelgianTaxProfile>) => void;
    /** Returns the meta for a year, or `null` if none exists. */
    metaForYear: (year: number) => BelgianTaxProfileSnapshotMeta | null;
    /** True if the year has a non-null `filing` meta record. */
    isYearFiled: (year: number) => boolean;
    /** Frozen "as-filed" calc, if one exists for the year. */
    getFrozenCalculation: (year: number) => BelgianTaxCalculation | null;
    /** Append-only audit log entries for a year, newest last. */
    getSnapshotHistory: (year: number) => SnapshotAuditEntry[];
    /**
     * Freeze the year's current live-recomputed calculation into `meta.frozenCalculation`.
     * Idempotent — overwrites any prior freeze. Appends `'frozen'`.
     */
    freezeCalculation: (year: number) => void;
    /** Clear `meta.frozenCalculation`. Appends `'unfrozen'`. No-op if not frozen. */
    unfreezeCalculation: (year: number) => void;
    /**
     * Mark a year as filed. Also freezes the calculation (engine-drift protection) if one
     * isn't already frozen. Appends `'filed'`.
     */
    markYearAsFiled: (year: number, reference?: string) => void;
    /** Clear the filing record. Does *not* unfreeze the calculation. Appends `'unfiled'`. */
    unmarkYearAsFiled: (year: number) => void;
}

const PROFILE_SETTINGS_KEY = 'belgian_tax_profile';
const SNAPSHOTS_SETTINGS_KEY = 'belgian_tax_profile_snapshots_v1';
const SNAPSHOT_METAS_SETTINGS_KEY = 'belgian_tax_profile_snapshot_meta_v1';
const MAX_HISTORY_ENTRIES_PER_YEAR = 200;

const defaultProfile: BelgianTaxProfile = {
    profileConfigured: false,
    employmentType: 'employee',
    grossAnnualIncome: 0,
    professionalExpenseMethod: 'lump_sum',
    actualProfessionalExpenses: 0,
    communalSurchargePercent: 7,
    region: 'flanders',
    dependentChildren: 0,
    dependentChildrenUnder3: 0,
    dependentChildrenDisabled: 0,
    dependentOtherPersons: 0,
    dependentOtherPersonsDisabled: 0,
    isDisabled: false,
    isSpouseDisabled: false,
    isIsolatedParent: false,
    cadastralIncome: 0,
    additionalResidences: [],
    otherTaxableIncome: 0,
    alimonyPaid: 0,
    personalPensionContributions: 0,
    pensionScheme: '1050',
    pensionEligible: false,
    lifeInsurancePremiums: 0,
    lifeInsuranceEligible: false,
    mortgageInterestPaid: 0,
    mortgageCapitalRepaid: 0,
    mortgageStartYear: undefined,
    mortgageRegion: undefined,
    mortgageIsPrimaryResidence: false,
    charitableDonations: 0,
    charitableDonationsEligible: false,
    childcareCosts: 0,
    childcareEligibleDays: 0,
    childcareEligible: false,
    employeeGroupInsuranceContributions: 0,
    employeeGroupInsuranceEligible: false,
    unionDues: 0,
    medicalExpenses: 0,
    domesticHelpCosts: 0,
    domesticHelpEligible: false,
    serviceVoucherCount: 0,
    serviceVoucherEligible: false,
    filingStatus: 'single',
    spouseProfessionalIncome: 0,
    annualDividendIncome: 0,
    annualSavingsInterest: 0,
    taxIncomeCategoryIds: [],
    taxYear: LATEST_TAX_YEAR,
};

const BelgianTaxProfileContext = createContext<BelgianTaxProfileContextType | undefined>(undefined);

function hasMeaningfulData(profile: BelgianTaxProfile): boolean {
    return (
        profile.profileConfigured === true ||
        (profile.grossAnnualIncome ?? 0) > 0 ||
        (profile.otherTaxableIncome ?? 0) > 0 ||
        (profile.cadastralIncome ?? 0) > 0 ||
        (profile.dependentChildren ?? 0) > 0 ||
        (profile.dependentOtherPersons ?? 0) > 0 ||
        (profile.actualProfessionalExpenses ?? 0) > 0
    );
}

export function BelgianTaxProfileProvider({ children }: { children: ReactNode }) {
    const [profile, setProfile] = useState<BelgianTaxProfile>(defaultProfile);
    const [snapshots, setSnapshots] = useState<BelgianTaxProfileSnapshots>({});
    const [snapshotMetas, setSnapshotMetas] = useState<BelgianTaxProfileSnapshotMetas>({});
    const [viewedYear, setViewedYearState] = useState<number>(defaultProfile.taxYear);
    const [isLoading, setIsLoading] = useState(true);
    // Debounced saves have no Save button: a silent failure means the user
    // believes an edit persisted when it didn't (gone on reload). Bump a nonce
    // on each failure so the toaster under LanguageProvider can surface it.
    const [saveErrorNonce, setSaveErrorNonce] = useState(0);
    const markSaveError = useCallback(() => setSaveErrorNonce((n) => n + 1), []);
    const hasInitializedViewedYear = useRef(false);

    const { value: preloadedProfile, isLoading: preloadProfileLoading } =
        usePreloadedSetting<BelgianTaxProfile>(PROFILE_SETTINGS_KEY);
    const { value: preloadedSnapshots, isLoading: preloadSnapshotsLoading } =
        usePreloadedSetting<BelgianTaxProfileSnapshots>(SNAPSHOTS_SETTINGS_KEY);
    const { value: preloadedMetas, isLoading: preloadMetasLoading } =
        usePreloadedSetting<BelgianTaxProfileSnapshotMetas>(SNAPSHOT_METAS_SETTINGS_KEY);

    useEffect(() => {
        if (preloadProfileLoading || preloadSnapshotsLoading || preloadMetasLoading) return;
        let mergedProfile: BelgianTaxProfile = defaultProfile;
        if (preloadedProfile) {
            mergedProfile = { ...defaultProfile, ...preloadedProfile };
            mergedProfile = { ...mergedProfile, profileConfigured: hasMeaningfulData(mergedProfile) };
            setProfile(mergedProfile);
        }
        if (preloadedSnapshots) {
            setSnapshots(preloadedSnapshots);
        }
        if (preloadedMetas) {
            setSnapshotMetas(preloadedMetas);
        }
        if (!hasInitializedViewedYear.current) {
            setViewedYearState(mergedProfile.taxYear);
            hasInitializedViewedYear.current = true;
        }
        setIsLoading(false);
    }, [
        preloadedProfile,
        preloadProfileLoading,
        preloadedSnapshots,
        preloadSnapshotsLoading,
        preloadedMetas,
        preloadMetasLoading,
    ]);

    useDebouncedSetting(PROFILE_SETTINGS_KEY, profile, isLoading, markSaveError, 'Failed to save Belgian tax profile:');
    useDebouncedSetting(SNAPSHOTS_SETTINGS_KEY, snapshots, isLoading, markSaveError, 'Failed to save Belgian tax profile snapshots:');
    useDebouncedSetting(SNAPSHOT_METAS_SETTINGS_KEY, snapshotMetas, isLoading, markSaveError, 'Failed to save Belgian tax profile snapshot meta:');

    /**
     * Append a history entry to a year's meta, creating the meta if absent. Trims to
     * `MAX_HISTORY_ENTRIES_PER_YEAR` from the head — old entries fall off so the JSONB
     * blob stays bounded even in pathological cases.
     */
    const appendHistory = useCallback(
        (year: number, kind: SnapshotAuditEntryKind, extras?: Omit<SnapshotAuditEntry, 'at' | 'kind'>) => {
            setSnapshotMetas((prev) => {
                const existing = prev[year];
                const entry: SnapshotAuditEntry = {
                    at: new Date().toISOString(),
                    kind,
                    ...extras,
                };
                const prevHistory = existing?.history ?? [];
                const nextHistory = [...prevHistory, entry];
                const trimmed =
                    nextHistory.length > MAX_HISTORY_ENTRIES_PER_YEAR
                        ? nextHistory.slice(nextHistory.length - MAX_HISTORY_ENTRIES_PER_YEAR)
                        : nextHistory;
                return {
                    ...prev,
                    [year]: { ...(existing ?? {}), history: trimmed },
                };
            });
        },
        [],
    );

    const updateProfile = useCallback(
        (updates: Partial<BelgianTaxProfile>) => {
            const prevYear = profile.taxYear;
            const nextYear = updates.taxYear ?? prevYear;
            const willArchive =
                typeof nextYear === 'number' &&
                typeof prevYear === 'number' &&
                nextYear > prevYear &&
                !snapshots[prevYear];

            setProfile((prev) => {
                const next = { ...prev, ...updates };
                const innerPrevYear = prev.taxYear;
                const innerNextYear = next.taxYear;
                if (
                    typeof innerNextYear === 'number' &&
                    typeof innerPrevYear === 'number' &&
                    innerNextYear > innerPrevYear
                ) {
                    setSnapshots((prevSnapshots) => {
                        if (prevSnapshots[innerPrevYear]) return prevSnapshots;
                        return { ...prevSnapshots, [innerPrevYear]: { ...prev } };
                    });
                }
                return next;
            });
            if (willArchive) {
                appendHistory(prevYear, 'created');
            }
        },
        [profile.taxYear, snapshots, appendHistory],
    );

    const resetProfile = useCallback(() => {
        setProfile(defaultProfile);
    }, []);

    const setViewedYear = useCallback((year: number) => {
        setViewedYearState(year);
    }, []);

    const snapshotExistsForYear = useCallback(
        (year: number) => Object.prototype.hasOwnProperty.call(snapshots, year),
        [snapshots],
    );

    const profileForYear = useCallback(
        (year: number): BelgianTaxProfile => {
            if (year === profile.taxYear) return profile;
            const snapshot = snapshots[year];
            if (snapshot) return snapshot;
            return { ...profile, taxYear: year };
        },
        [profile, snapshots],
    );

    const calculationForYear = useCallback(
        (year: number): BelgianTaxCalculation => computeBelgianPIT(profileForYear(year)),
        [profileForYear],
    );

    const createSnapshotFromLive = useCallback(
        (year: number) => {
            if (snapshots[year]) return;
            setSnapshots((prev) => {
                if (prev[year]) return prev;
                return { ...prev, [year]: { ...profile, taxYear: year } };
            });
            appendHistory(year, 'created');
        },
        [profile, snapshots, appendHistory],
    );

    const updateSnapshot = useCallback(
        (year: number, updates: Partial<BelgianTaxProfile>) => {
            if (!snapshots[year]) return;
            setSnapshots((prev) => {
                const existing = prev[year];
                if (!existing) return prev;
                return { ...prev, [year]: { ...existing, ...updates, taxYear: year } };
            });
            // Strip `taxYear` from the recorded diff — it's coerced server-side and not meaningful.
            const { taxYear: _ignored, ...rest } = updates;
            void _ignored;
            if (Object.keys(rest).length > 0) {
                appendHistory(year, 'patched', { changes: rest });
            }
        },
        [snapshots, appendHistory],
    );

    const metaForYear = useCallback(
        (year: number): BelgianTaxProfileSnapshotMeta | null => snapshotMetas[year] ?? null,
        [snapshotMetas],
    );

    const isYearFiled = useCallback(
        (year: number): boolean => !!snapshotMetas[year]?.filing,
        [snapshotMetas],
    );

    const getFrozenCalculation = useCallback(
        (year: number): BelgianTaxCalculation | null =>
            snapshotMetas[year]?.frozenCalculation ?? null,
        [snapshotMetas],
    );

    const getSnapshotHistory = useCallback(
        (year: number): SnapshotAuditEntry[] => snapshotMetas[year]?.history ?? [],
        [snapshotMetas],
    );

    const freezeCalculation = useCallback(
        (year: number) => {
            const frozen = computeBelgianPIT(profileForYear(year));
            setSnapshotMetas((prev) => {
                const existing = prev[year];
                return { ...prev, [year]: { ...(existing ?? {}), frozenCalculation: frozen } };
            });
            appendHistory(year, 'frozen');
        },
        [profileForYear, appendHistory],
    );

    const unfreezeCalculation = useCallback(
        (year: number) => {
            if (!snapshotMetas[year]?.frozenCalculation) return;
            setSnapshotMetas((prev) => {
                const existing = prev[year];
                if (!existing?.frozenCalculation) return prev;
                const { frozenCalculation: _drop, ...rest } = existing;
                void _drop;
                return { ...prev, [year]: rest };
            });
            appendHistory(year, 'unfrozen');
        },
        [snapshotMetas, appendHistory],
    );

    const markYearAsFiled = useCallback(
        (year: number, reference?: string) => {
            const frozen = computeBelgianPIT(profileForYear(year));
            setSnapshotMetas((prev) => {
                const existing = prev[year];
                const filing = {
                    filedAt: new Date().toISOString(),
                    ...(reference ? { reference } : {}),
                };
                // Filing implies freezing — preserve any pre-existing frozen calc instead of
                // overwriting it. This way if a user froze deliberately *then* filed, their
                // chosen freeze point is what stays "as filed".
                return {
                    ...prev,
                    [year]: {
                        ...(existing ?? {}),
                        filing,
                        frozenCalculation: existing?.frozenCalculation ?? frozen,
                    },
                };
            });
            appendHistory(year, 'filed', reference ? { reference } : undefined);
        },
        [profileForYear, appendHistory],
    );

    const unmarkYearAsFiled = useCallback(
        (year: number) => {
            if (!snapshotMetas[year]?.filing) return;
            setSnapshotMetas((prev) => {
                const existing = prev[year];
                if (!existing?.filing) return prev;
                const { filing: _drop, ...rest } = existing;
                void _drop;
                return { ...prev, [year]: rest };
            });
            appendHistory(year, 'unfiled');
        },
        [snapshotMetas, appendHistory],
    );

    const calculation = useMemo(() => computeBelgianPIT(profile), [profile]);
    const isViewingHistorical = viewedYear !== profile.taxYear;

    const displayCalculationForYear = useCallback(
        (year: number): BelgianTaxCalculation => {
            const frozen = snapshotMetas[year]?.frozenCalculation;
            if (frozen) return frozen;
            return computeBelgianPIT(profileForYear(year));
        },
        [snapshotMetas, profileForYear],
    );

    const contextValue = useMemo(
        () => ({
            profile,
            updateProfile,
            resetProfile,
            calculation,
            isLoading,
            saveErrorNonce,
            snapshots,
            snapshotMetas,
            viewedYear,
            setViewedYear,
            isViewingHistorical,
            snapshotExistsForYear,
            profileForYear,
            calculationForYear,
            displayCalculationForYear,
            createSnapshotFromLive,
            updateSnapshot,
            metaForYear,
            isYearFiled,
            getFrozenCalculation,
            getSnapshotHistory,
            freezeCalculation,
            unfreezeCalculation,
            markYearAsFiled,
            unmarkYearAsFiled,
        }),
        [
            profile,
            updateProfile,
            resetProfile,
            calculation,
            isLoading,
            saveErrorNonce,
            snapshots,
            snapshotMetas,
            viewedYear,
            setViewedYear,
            isViewingHistorical,
            snapshotExistsForYear,
            profileForYear,
            calculationForYear,
            displayCalculationForYear,
            createSnapshotFromLive,
            updateSnapshot,
            metaForYear,
            isYearFiled,
            getFrozenCalculation,
            getSnapshotHistory,
            freezeCalculation,
            unfreezeCalculation,
            markYearAsFiled,
            unmarkYearAsFiled,
        ],
    );

    return (
        <BelgianTaxProfileContext.Provider value={contextValue}>
            {children}
        </BelgianTaxProfileContext.Provider>
    );
}

/**
 * Surfaces a translated toast when a debounced tax-profile persist fails.
 * Mounted UNDER LanguageProvider (the provider above it cannot translate),
 * mirroring AppSettingsSaveErrorToaster.
 */
export function BelgianTaxSaveErrorToaster() {
    const { t } = useLanguage();
    const { saveErrorNonce } = useBelgianTaxProfile();
    const lastSeen = useRef(saveErrorNonce);
    useEffect(() => {
        if (saveErrorNonce !== lastSeen.current) {
            lastSeen.current = saveErrorNonce;
            if (saveErrorNonce > 0) toast.error(t('settings.saveFailed'));
        }
    }, [saveErrorNonce, t]);
    return null;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBelgianTaxProfile() {
    const ctx = useContext(BelgianTaxProfileContext);
    if (!ctx) throw new Error('useBelgianTaxProfile must be used within BelgianTaxProfileProvider');
    return ctx;
}
