/**
 * BelgianTaxProfileContext
 *
 * Stores and persists the user's Belgian tax profile and exposes the derived PIT calculation.
 *
 * Pure tax logic lives in `@/lib/belgianTax`. This file only owns React state, persistence,
 * and the context wiring.
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
    type BelgianTaxCalculation,
} from '@/lib/belgianTax';

// Re-export the public surface so consumers can keep importing from this path.
export type {
    BelgianTaxProfile,
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
    profile: BelgianTaxProfile;
    updateProfile: (updates: Partial<BelgianTaxProfile>) => void;
    resetProfile: () => void;
    calculation: BelgianTaxCalculation;
    isLoading: boolean;
}

const SETTINGS_KEY = 'belgian_tax_profile';
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
    dependentOtherPersons: 0,
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
    const [isLoading, setIsLoading] = useState(true);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isFirstRender = useRef(true);

    const { value: preloaded, isLoading: preloadLoading } = usePreloadedSetting<BelgianTaxProfile>(SETTINGS_KEY);

    useEffect(() => {
        if (preloadLoading) return;
        if (preloaded) {
            const merged: BelgianTaxProfile = { ...defaultProfile, ...preloaded };
            setProfile({ ...merged, profileConfigured: hasMeaningfulData(merged) });
        }
        setIsLoading(false);
    }, [preloaded, preloadLoading]);

    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        if (isLoading) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            apiClient.saveSetting(SETTINGS_KEY, profile).catch((err) => {
                logger.error('Failed to save Belgian tax profile:', err);
            });
        }, PERSIST_DEBOUNCE_MS);
        return () => {
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        };
    }, [profile, isLoading]);

    const updateProfile = useCallback((updates: Partial<BelgianTaxProfile>) => {
        setProfile((prev) => ({ ...prev, ...updates }));
    }, []);

    const resetProfile = useCallback(() => {
        setProfile(defaultProfile);
    }, []);

    const calculation = useMemo(() => computeBelgianPIT(profile), [profile]);
    const contextValue = useMemo(
        () => ({ profile, updateProfile, resetProfile, calculation, isLoading }),
        [profile, updateProfile, resetProfile, calculation, isLoading],
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
