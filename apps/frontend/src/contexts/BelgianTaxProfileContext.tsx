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
import { apiClient } from '@/lib/api';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';
import logger from '@/lib/logger';
import {
    computeBelgianPIT,
    LATEST_TAX_YEAR,
    type BelgianTaxProfile,
    type BelgianTaxProfileSnapshots,
    type BelgianTaxCalculation,
} from '@/lib/belgianTax';

// Re-export the public surface so consumers can keep importing from this path.
export type {
    BelgianTaxProfile,
    BelgianTaxProfileSnapshots,
    BelgianTaxCalculation,
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
    /** Frozen per-year profile snapshots, keyed by income year. */
    snapshots: BelgianTaxProfileSnapshots;
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
    /** Compute the PIT calculation for a given year using `profileForYear`. */
    calculationForYear: (year: number) => BelgianTaxCalculation;
    /**
     * Seed a snapshot for a year by cloning the current live profile (with `taxYear`
     * overridden). No-op if a snapshot already exists for that year.
     */
    createSnapshotFromLive: (year: number) => void;
    /** Patch a snapshot in place. Used by the dialog's historical-edit mode. */
    updateSnapshot: (year: number, updates: Partial<BelgianTaxProfile>) => void;
}

const PROFILE_SETTINGS_KEY = 'belgian_tax_profile';
const SNAPSHOTS_SETTINGS_KEY = 'belgian_tax_profile_snapshots_v1';
const PERSIST_DEBOUNCE_MS = 500;

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
    const [viewedYear, setViewedYearState] = useState<number>(defaultProfile.taxYear);
    const [isLoading, setIsLoading] = useState(true);
    const profileSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const snapshotsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isFirstProfileRender = useRef(true);
    const isFirstSnapshotsRender = useRef(true);
    const hasInitializedViewedYear = useRef(false);

    const { value: preloadedProfile, isLoading: preloadProfileLoading } =
        usePreloadedSetting<BelgianTaxProfile>(PROFILE_SETTINGS_KEY);
    const { value: preloadedSnapshots, isLoading: preloadSnapshotsLoading } =
        usePreloadedSetting<BelgianTaxProfileSnapshots>(SNAPSHOTS_SETTINGS_KEY);

    useEffect(() => {
        if (preloadProfileLoading || preloadSnapshotsLoading) return;
        let mergedProfile: BelgianTaxProfile = defaultProfile;
        if (preloadedProfile) {
            mergedProfile = { ...defaultProfile, ...preloadedProfile };
            mergedProfile = { ...mergedProfile, profileConfigured: hasMeaningfulData(mergedProfile) };
            setProfile(mergedProfile);
        }
        if (preloadedSnapshots) {
            setSnapshots(preloadedSnapshots);
        }
        if (!hasInitializedViewedYear.current) {
            setViewedYearState(mergedProfile.taxYear);
            hasInitializedViewedYear.current = true;
        }
        setIsLoading(false);
    }, [preloadedProfile, preloadProfileLoading, preloadedSnapshots, preloadSnapshotsLoading]);

    useEffect(() => {
        if (isFirstProfileRender.current) {
            isFirstProfileRender.current = false;
            return;
        }
        if (isLoading) return;
        if (profileSaveTimerRef.current) clearTimeout(profileSaveTimerRef.current);
        profileSaveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(PROFILE_SETTINGS_KEY, profile).catch((err) => {
                logger.error('Failed to save Belgian tax profile:', err);
            });
        }, PERSIST_DEBOUNCE_MS);
        return () => {
            if (profileSaveTimerRef.current) clearTimeout(profileSaveTimerRef.current);
        };
    }, [profile, isLoading]);

    useEffect(() => {
        if (isFirstSnapshotsRender.current) {
            isFirstSnapshotsRender.current = false;
            return;
        }
        if (isLoading) return;
        if (snapshotsSaveTimerRef.current) clearTimeout(snapshotsSaveTimerRef.current);
        snapshotsSaveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SNAPSHOTS_SETTINGS_KEY, snapshots).catch((err) => {
                logger.error('Failed to save Belgian tax profile snapshots:', err);
            });
        }, PERSIST_DEBOUNCE_MS);
        return () => {
            if (snapshotsSaveTimerRef.current) clearTimeout(snapshotsSaveTimerRef.current);
        };
    }, [snapshots, isLoading]);

    const updateProfile = useCallback((updates: Partial<BelgianTaxProfile>) => {
        setProfile((prev) => {
            const next = { ...prev, ...updates };
            const nextYear = next.taxYear;
            const prevYear = prev.taxYear;
            // Auto-rollover: when the active income year advances, archive the outgoing
            // profile as a snapshot under its own year key (without the new updates).
            if (typeof nextYear === 'number' && typeof prevYear === 'number' && nextYear > prevYear) {
                setSnapshots((prevSnapshots) => {
                    if (prevSnapshots[prevYear]) return prevSnapshots;
                    return { ...prevSnapshots, [prevYear]: { ...prev } };
                });
            }
            return next;
        });
    }, []);

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
            setSnapshots((prev) => {
                if (prev[year]) return prev;
                return { ...prev, [year]: { ...profile, taxYear: year } };
            });
        },
        [profile],
    );

    const updateSnapshot = useCallback((year: number, updates: Partial<BelgianTaxProfile>) => {
        setSnapshots((prev) => {
            const existing = prev[year];
            if (!existing) return prev;
            return { ...prev, [year]: { ...existing, ...updates, taxYear: year } };
        });
    }, []);

    const calculation = useMemo(() => computeBelgianPIT(profile), [profile]);
    const isViewingHistorical = viewedYear !== profile.taxYear;

    const contextValue = useMemo(
        () => ({
            profile,
            updateProfile,
            resetProfile,
            calculation,
            isLoading,
            snapshots,
            viewedYear,
            setViewedYear,
            isViewingHistorical,
            snapshotExistsForYear,
            profileForYear,
            calculationForYear,
            createSnapshotFromLive,
            updateSnapshot,
        }),
        [
            profile,
            updateProfile,
            resetProfile,
            calculation,
            isLoading,
            snapshots,
            viewedYear,
            setViewedYear,
            isViewingHistorical,
            snapshotExistsForYear,
            profileForYear,
            calculationForYear,
            createSnapshotFromLive,
            updateSnapshot,
        ],
    );

    return (
        <BelgianTaxProfileContext.Provider value={contextValue}>
            {children}
        </BelgianTaxProfileContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useBelgianTaxProfile() {
    const ctx = useContext(BelgianTaxProfileContext);
    if (!ctx) throw new Error('useBelgianTaxProfile must be used within BelgianTaxProfileProvider');
    return ctx;
}
