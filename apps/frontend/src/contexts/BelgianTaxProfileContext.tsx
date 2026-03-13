/**
 * BelgianTaxProfileContext
 *
 * Stores and persists the user's Belgian tax profile:
 * - Employment type (employee / self-employed / civil servant / retired)
 * - Gross annual income
 * - Professional expense method (lump-sum or actual)
 * - Actual professional expenses (if opted)
 * - Communal/municipal surcharge percentage
 * - Belgian region (Flanders / Wallonia / Brussels)
 * - Applicable exemptions (e.g. disabled person, dependent children, etc.)
 * - Property tax (cadastral income)
 *
 * All calculations are Belgian-law based (PwC 2025 data).
 */
import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useRef,
    type ReactNode,
} from 'react';
import { apiClient } from '@/lib/api';
import { usePreloadedSetting } from '@/contexts/SettingsPreloadContext';
import logger from '@/lib/logger';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type EmploymentType = 'employee' | 'self_employed' | 'civil_servant' | 'retired' | 'other';
export type BelgianRegion = 'flanders' | 'wallonia' | 'brussels';
export type ProfessionalExpenseMethod = 'lump_sum' | 'actual';

export interface BelgianTaxProfile {
    /** Whether the user has completed the initial setup */
    profileConfigured: boolean;
    /** Employment / income type */
    employmentType: EmploymentType;
    /** Gross annual income in EUR */
    grossAnnualIncome: number;
    /** Professional expense deduction method */
    professionalExpenseMethod: ProfessionalExpenseMethod;
    /** Actual professional expenses (only used when method = 'actual') */
    actualProfessionalExpenses: number;
    /** Municipal/communal surcharge percentage (0–9) */
    communalSurchargePercent: number;
    /** Belgian administrative region */
    region: BelgianRegion;
    /** Number of dependent children (for tax reduction) */
    dependentChildren: number;
    /** Dependent other persons count */
    dependentOtherPersons: number;
    /** Is the taxpayer disabled? */
    isDisabled: boolean;
    /** Is the taxpayer's spouse/partner disabled? */
    isSpouseDisabled: boolean;
    /** Annual cadastral income for owned property (EUR) */
    cadastralIncome: number;
    /** Additional residences (other properties) */
    additionalResidences?: { label?: string; cadastralIncome: number; region?: BelgianRegion }[];
    /** Other annual taxable income (rental, misc.) */
    otherTaxableIncome: number;
    /** Alimony paid (annual, EUR) - deductible in many cases */
    alimonyPaid: number;
    /** Personal pension contributions / voluntary retirement savings (annual, EUR) */
    personalPensionContributions: number;
    /** Pension savings scheme selection: '1050' (30%) or '1350' (25%) */
    pensionScheme?: '1050' | '1350';
    /** Whether pension contributions are eligible for the tax reduction (credit) */
    pensionEligible?: boolean;
    /** Life / long-term insurance premiums (annual, EUR) */
    lifeInsurancePremiums: number;
    /** Whether life insurance premiums qualify for the tax reduction (credit) */
    lifeInsuranceEligible?: boolean;
    /** Mortgage interest paid on main residence (annual, EUR) */
    mortgageInterestPaid: number;
    /** Charitable donations (annual, EUR) */
    charitableDonations: number;
    /** Whether charitable donations qualify for the 45% tax reduction (minimum €40, recognised institutions) */
    charitableDonationsEligible?: boolean;
    /** Childcare costs (annual, EUR) */
    childcareCosts: number;
    /** Number of eligible childcare days (children under 14, income year 2025) */
    childcareEligibleDays?: number;
    /** Whether the taxpayer is eligible for the child custody/tax credit (45% up to €16.90/day per child) */
    childcareEligible?: boolean;
    /** Employee contributions to group insurance (annual, EUR) */
    employeeGroupInsuranceContributions?: number;
    /** Whether employee group-insurance contributions qualify for the federal 30% reduction */
    employeeGroupInsuranceEligible?: boolean;
    /** Union or professional dues (annual, EUR) */
    unionDues: number;
    /** Medical expenses (annual, EUR) */
    medicalExpenses: number;
    /** Domestic personnel / household help costs (annual, EUR) — used for 30% tax reduction when eligible */
    domesticHelpCosts?: number;
    /** Whether domestic help costs are eligible for the 30% tax reduction */
    domesticHelpEligible?: boolean;
    /** Tax year (for bracket reference) */
    taxYear: number;
}

export interface BelgianTaxCalculation {
    grossIncome: number;
    employeeSocialSecurity: number;
    specialSocialSecurityContribution: number;
    personalExemptionAmount: number;
    netIncomeAfterSS: number;
    professionalExpenses: number;
    otherDeductionsTotal: number;
    deductions: Record<string, number>;
    taxableIncome: number;
    federalPITBracket1: number;
    federalPITBracket2: number;
    federalPITBracket3: number;
    federalPITBracket4: number;
    federalPITTotal: number;
    personalExemptionBenefit: number;
    federalTaxCredits: number;
    taxReductions: number;
    federalPITAfterReductions: number;
    communalSurcharge: number;
    totalPIT: number;
    totalTaxBurden: number;
    effectiveRate: number;
    marginalRate: number;
    netTakeHome: number;
    monthlyTaxReserve: number;
    /** Estimated annual property tax from all residences (informational, regional estimate) */
    propertyTaxEstimate: number;
    breakdown: {
        label: string;
        amount: number;
        rate?: number;
        bracket?: string;
    }[];
}

interface BelgianTaxProfileContextType {
    profile: BelgianTaxProfile;
    updateProfile: (updates: Partial<BelgianTaxProfile>) => void;
    resetProfile: () => void;
    calculation: BelgianTaxCalculation;
    isLoading: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Constants (2025 Belgian tax law, PwC)
// ──────────────────────────────────────────────────────────────────────────────

export const BELGIAN_TAX_BRACKETS_2025 = [
    { from: 0,      to: 16_320,  rate: 0.25 },
    { from: 16_320, to: 28_800,  rate: 0.40 },
    { from: 28_800, to: 49_840,  rate: 0.45 },
    { from: 49_840, to: Infinity, rate: 0.50 },
];

/** Employee social security rate (13.07% of gross) */
export const EMPLOYEE_SS_RATE = 0.1307;

/** Lump-sum professional expense deduction caps (2025) */
export const LUMP_SUM_PROFESSIONAL_EXPENSE_RATE = 0.30;
export const LUMP_SUM_PROFESSIONAL_EXPENSE_CAP = 5_930;
export const LUMP_SUM_PROFESSIONAL_EXPENSE_MIN = 0;
export const DIRECTOR_PROFESSIONAL_EXPENSE_RATE = 0.03;
export const DIRECTOR_PROFESSIONAL_EXPENSE_CAP = 3_130;

/** Personal tax-free allowance and dependent exemption increases (income year 2025) */
export const BASIC_PERSONAL_EXEMPTION = 10_910;
export const DEPENDENT_CHILD_EXEMPTION_INCREASES = [0, 1_980, 5_110, 11_440, 18_510];
export const EXTRA_CHILD_EXEMPTION_FROM_FIFTH = 7_070;
export const OTHER_DEPENDENT_EXEMPTION = 1_980;

/** Special social security contribution (annual family cap); estimated from PwC range */
export const SPECIAL_SS_MIN_ANNUAL = 9.30 * 12;
export const SPECIAL_SS_MAX_ANNUAL = 731.28;

// Note: personal exemption is handled by reducing taxable income directly
// (see computeBelgianPIT) rather than using a separate benefit table.

/** Default communal surcharge by region (approximate median) */
export const DEFAULT_COMMUNAL_SURCHARGE: Record<BelgianRegion, number> = {
    flanders: 7,
    wallonia: 7.5,
    brussels: 7,
};

// Region multipliers used as pragmatic estimates to convert cadastral income -> annual property tax
export const REGION_CADASTRAL_MULTIPLIER: Record<BelgianRegion, number> = {
    flanders: 1.6,
    wallonia: 1.7,
    brussels: 1.8,
};

// PwC Belgium (individual deductions, reviewed 13 Feb 2026)
export const PENSION_SAVINGS_CAP_STANDARD = 1_050;
export const PENSION_SAVINGS_CAP_ALTERNATIVE = 1_350;
export const LIFE_INSURANCE_CAP = 2_530;
export const CHARITABLE_DONATION_MIN = 40;
export const CHILDCARE_DAILY_CAP_2025 = 16.90;


const SETTINGS_KEY = 'belgian_tax_profile';

// ──────────────────────────────────────────────────────────────────────────────
// Default profile
// ──────────────────────────────────────────────────────────────────────────────

const defaultProfile: BelgianTaxProfile = {
    profileConfigured: false,
    employmentType: 'employee',
    grossAnnualIncome: 0,
    professionalExpenseMethod: 'lump_sum',
    actualProfessionalExpenses: 0,
    communalSurchargePercent: 7,
    region: 'flanders',
    dependentChildren: 0,
    dependentOtherPersons: 0,
    isDisabled: false,
    isSpouseDisabled: false,
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
    taxYear: 2025,
};

// ──────────────────────────────────────────────────────────────────────────────
// Calculation engine
// ──────────────────────────────────────────────────────────────────────────────

export function computeBelgianPIT(profile: BelgianTaxProfile): BelgianTaxCalculation {
    const gross = profile.grossAnnualIncome + profile.otherTaxableIncome;

    // 1. Employee social security (13.07% of gross salary only, not other income)
    const employeeSS = profile.employmentType === 'employee' || profile.employmentType === 'civil_servant'
        ? profile.grossAnnualIncome * EMPLOYEE_SS_RATE
        : 0;

    const netAfterSS = gross - employeeSS;

    // 2. Professional expense deduction
    let profExpenses: number;
    if (profile.professionalExpenseMethod === 'actual') {
        profExpenses = Math.max(profile.actualProfessionalExpenses, 0);
    } else {
        // PwC: employees can claim 30% with ceiling EUR 5,930.
        // PwC: remunerated directors can claim 3% with ceiling EUR 3,130.
        // We map the "self_employed" profile bucket to the director-style forfait.
        if (profile.employmentType === 'self_employed') {
            profExpenses = Math.min(profile.grossAnnualIncome * DIRECTOR_PROFESSIONAL_EXPENSE_RATE, DIRECTOR_PROFESSIONAL_EXPENSE_CAP);
        } else {
            profExpenses = Math.min(profile.grossAnnualIncome * LUMP_SUM_PROFESSIONAL_EXPENSE_RATE, LUMP_SUM_PROFESSIONAL_EXPENSE_CAP);
        }
    }

    // 3. Taxable income before personal exemptions
    // PwC classifies pension savings, life insurance, donations, group insurance, childcare,
    // and domestic personnel as tax reductions (credits), not deductions from taxable basis.
    // Therefore only true deductible amounts are included here.
    const cappedPension = 0;
    const cappedLifeIns = 0;
    const cappedMortgage = 0; // regional adjustment, not auto-applied federally
    const cappedDonations = 0;
    const cappedChildcare = 0;
    const cappedUnion = Math.max(profile.unionDues || 0, 0);
    const cappedMedical = Math.max(profile.medicalExpenses || 0, 0);
    // Alimony: PwC indicates that alimony payments are deductible at 80% for the payer in many cases.
    // We apply the legal percentage directly (80%) without a synthetic fraction cap.
    // Source: PwC — Belgium — Individual — Deductions (reviewed 13 Feb 2026).
    const cappedAlimony = Math.max(profile.alimonyPaid || 0, 0) * 0.80;

    // Note: pension, life insurance, donations, childcare and domestic help are handled as tax
    // reductions (credits) below and are therefore NOT included in otherDeductions for the federal PIT.
    const otherDeductions = (
        cappedAlimony
        // + cappedPension (credit)
        // + cappedLifeIns (credit)
        // + cappedMortgage (regional)
        // + cappedDonations (credit)
        // + cappedChildcare (credit)
        + cappedUnion
        + cappedMedical
    );

    const taxableIncome = Math.max(netAfterSS - profExpenses - otherDeductions, 0);

    const childExemption =
        profile.dependentChildren <= 4
            ? DEPENDENT_CHILD_EXEMPTION_INCREASES[profile.dependentChildren] ?? 0
            : (DEPENDENT_CHILD_EXEMPTION_INCREASES[4] ?? 0) + ((profile.dependentChildren - 4) * EXTRA_CHILD_EXEMPTION_FROM_FIFTH);
    const otherDependentExemption = profile.dependentOtherPersons * OTHER_DEPENDENT_EXEMPTION;
    const personalExemptionTotal = BASIC_PERSONAL_EXEMPTION + childExemption + otherDependentExemption;

    const brackets = BELGIAN_TAX_BRACKETS_2025;

    function computeProgressiveTax(value: number) {
        let b1 = 0;
        let b2 = 0;
        let b3 = 0;
        let b4 = 0;

        if (value > brackets[0].from) {
            b1 = (Math.min(value, brackets[0].to) - brackets[0].from) * brackets[0].rate;
        }
        if (value > brackets[1].from) {
            b2 = (Math.min(value, brackets[1].to) - brackets[1].from) * brackets[1].rate;
        }
        if (value > brackets[2].from) {
            b3 = (Math.min(value, brackets[2].to) - brackets[2].from) * brackets[2].rate;
        }
        if (value > brackets[3].from) {
            b4 = (value - brackets[3].from) * brackets[3].rate;
        }

        return { b1, b2, b3, b4, total: b1 + b2 + b3 + b4 };
    }

    // Compute progressive tax before and after applying personal exemptions.
    const pitBeforeExemptions = computeProgressiveTax(taxableIncome);
    const taxableAfterPersonalExemptions = Math.max(taxableIncome - personalExemptionTotal, 0);
    const pitAfterExemptions = computeProgressiveTax(taxableAfterPersonalExemptions);

    const bracket1 = pitBeforeExemptions.b1;
    const bracket2 = pitBeforeExemptions.b2;
    const bracket3 = pitBeforeExemptions.b3;
    const bracket4 = pitBeforeExemptions.b4;

    // Federal PIT before federal tax reductions.
    // Keep this as tax on taxable income before personal exemptions so that the personal exemption
    // benefit remains explicit and correctly displayed as its own reduction line.
    const federalPITBeforeCredits = pitBeforeExemptions.total;
    const personalExemptionBenefit = Math.max(0, pitBeforeExemptions.total - pitAfterExemptions.total);
    const pitAfterPersonalExemptions = pitAfterExemptions.total;

    // --- Compute tax credits (reductions) per PwC guidance ---
    // Pension savings: two ceilings (EUR 1,050 @30% or EUR 1,350 @25%) depending on the chosen scheme.
    // Source: PwC — Belgium — Individual — Deductions (reviewed 13 Feb 2026).
    const pensionCeiling = profile.pensionScheme === '1350' ? PENSION_SAVINGS_CAP_ALTERNATIVE : PENSION_SAVINGS_CAP_STANDARD;
    const pensionRate = profile.pensionScheme === '1350' ? 0.25 : 0.30;
    const pensionCredit = profile.pensionEligible
        ? Math.min(profile.personalPensionContributions || 0, pensionCeiling) * pensionRate
        : 0;

    // Life insurance: 30% tax reduction up to EUR 2,530 (PwC). Treated as a tax credit.
    const lifeInsuranceCredit = profile.lifeInsuranceEligible
        ? Math.min(profile.lifeInsurancePremiums || 0, LIFE_INSURANCE_CAP) * 0.30
        : 0;

    // Employee contributions to group insurance: 30% tax reduction (PwC).
    const groupInsuranceCredit = profile.employeeGroupInsuranceEligible
        ? Math.max(profile.employeeGroupInsuranceContributions || 0, 0) * 0.30
        : 0;

    // Charitable donations: minimum donation EUR 40 and must be to recognised EEA institution to qualify;
    // tax reduction typically 45% (PwC). We require the user to mark eligibility (recognised charity).
    const donationCredit = profile.charitableDonationsEligible && (profile.charitableDonations || 0) >= CHARITABLE_DONATION_MIN
        ? 0.45 * (profile.charitableDonations || 0)
        : 0;

    // Childcare / custody credit: PwC indicates a 45% credit up to EUR 16.90/day (2025) per eligible child.
    // Precise application requires number of eligible days; as an approximation we treat the provided annual
    // childcareCosts as the amount claimed and cap it by an assumed annual days multiplier when the user
    // hasn't provided day counts. This assumption is documented and should be refined with more input.
    // See note below and in UI for assumptions. Source: PwC.
    const childcareAnnualCap = Math.max(profile.childcareEligibleDays || 0, 0) * CHILDCARE_DAILY_CAP_2025;
    const childcareCredit = profile.childcareEligible
        ? 0.45 * Math.min(profile.childcareCosts || 0, childcareAnnualCap)
        : 0;

    // Domestic personnel / household help: PwC indicates a 30% tax reduction when eligible; exact caps
    // depend on circumstances. We'll apply 30% to the declared domesticHelpCosts when the eligibility flag
    // is set and document this as an assumption.
    const domesticHelpCredit = profile.domesticHelpEligible
        ? 0.30 * (profile.domesticHelpCosts || 0)
        : 0;

    const totalTaxCredits = pensionCredit + lifeInsuranceCredit + groupInsuranceCredit + donationCredit + childcareCredit + domesticHelpCredit;

    const federalPIT = federalPITBeforeCredits;
    const federalPITAfterReductions = Math.max(0, pitAfterPersonalExemptions - totalTaxCredits);
    const effectiveTaxReductions = personalExemptionBenefit + totalTaxCredits;

    // 6. Communal surcharge
    const communalSurcharge = federalPITAfterReductions * (profile.communalSurchargePercent / 100);

    // 7. Special social security contribution (employee/civil servant estimate)
    const specialSocialSecurityContribution = profile.employmentType === 'employee' || profile.employmentType === 'civil_servant'
        ? (() => {
            if (gross <= 0 || taxableIncome <= 0) return 0;
            const ratio = Math.max(0, Math.min(taxableIncome / 60_000, 1));
            return SPECIAL_SS_MIN_ANNUAL + ((SPECIAL_SS_MAX_ANNUAL - SPECIAL_SS_MIN_ANNUAL) * ratio);
        })()
        : 0;

    // 8. Totals
    const totalPIT = federalPITAfterReductions + communalSurcharge;

    // Property tax — aggregate main residence and any additional residences as an informational estimate.
    const residences = [{ cadastralIncome: profile.cadastralIncome || 0, region: profile.region }, ...(profile.additionalResidences || [])];
    const propertyTaxEstimate = residences.reduce((sum, r) => {
        const mult = REGION_CADASTRAL_MULTIPLIER[r.region || profile.region];
        return sum + (r.cadastralIncome || 0) * mult;
    }, 0);

    // Total burden: federal PIT + communal surcharge + social security + estimated property tax (informational)
    const totalTaxBurden = totalPIT + communalSurcharge + employeeSS + specialSocialSecurityContribution + propertyTaxEstimate;
    const effectiveRate = gross > 0 ? (totalTaxBurden / gross) * 100 : 0;

    // Marginal rate: which bracket does taxable income fall in?
    let marginalRate = 25;
    for (const b of BELGIAN_TAX_BRACKETS_2025) {
        if (taxableIncome > b.from) marginalRate = b.rate * 100;
    }

    const netTakeHome = gross - totalTaxBurden;
    const monthlyTaxReserve = totalPIT / 12;

    // Build breakdown for display
    const breakdown = [
        { label: 'Gross Income', amount: gross },
        { label: 'Employee Social Security (−13.07%)', amount: -employeeSS, rate: EMPLOYEE_SS_RATE * 100 },
        { label: 'Net after Social Security', amount: netAfterSS },
        { label: 'Professional Expenses Deduction', amount: -profExpenses },
        // show each deduction individually
        ...(profile.alimonyPaid ? [{ label: 'Alimony paid (80% deductible)', amount: -cappedAlimony }] : []),
        // Pension, life insurance, donations, childcare and domestic help are tax credits — show them as credits
        ...(profile.personalPensionContributions ? [{ label: 'Personal pension contributions (credit)', amount: -(profile.personalPensionContributions || 0) }] : []),
        ...(profile.lifeInsurancePremiums ? [{ label: 'Life / insurance premiums (credit)', amount: -(profile.lifeInsurancePremiums || 0) }] : []),
        ...(profile.mortgageInterestPaid ? [{ label: 'Mortgage interest (main residence) — regional adjustment', amount: -(profile.mortgageInterestPaid || 0) }] : []),
        ...(profile.charitableDonations ? [{ label: 'Charitable donations (credit)', amount: -(profile.charitableDonations || 0) }] : []),
        ...(profile.childcareCosts ? [{ label: 'Childcare costs (credit)', amount: -(profile.childcareCosts || 0) }] : []),
        ...(profile.unionDues ? [{ label: 'Union / professional dues', amount: -profile.unionDues }] : []),
        ...(profile.medicalExpenses ? [{ label: 'Medical expenses', amount: -profile.medicalExpenses }] : []),
        { label: 'Taxable Income', amount: taxableIncome },
        ...(bracket1 > 0 ? [{ label: 'Bracket 1 (25%)', amount: -bracket1, rate: 25, bracket: '€0 – €16,320' }] : []),
        ...(bracket2 > 0 ? [{ label: 'Bracket 2 (40%)', amount: -bracket2, rate: 40, bracket: '€16,320 – €28,800' }] : []),
        ...(bracket3 > 0 ? [{ label: 'Bracket 3 (45%)', amount: -bracket3, rate: 45, bracket: '€28,800 – €49,840' }] : []),
        ...(bracket4 > 0 ? [{ label: 'Bracket 4 (50%)', amount: -bracket4, rate: 50, bracket: '€49,840+' }] : []),
        ...(personalExemptionBenefit > 0 ? [
            { label: 'Personal exemption benefit', amount: -personalExemptionBenefit },
        ] : []),
        ...(totalTaxCredits > 0 ? [
            { label: 'Tax Credits (reductions) — detail', amount: -totalTaxCredits },
        ] : []),
        { label: `Federal PIT (before credits)`, amount: -federalPITBeforeCredits },
        { label: `Federal PIT (after credits)`, amount: -federalPITAfterReductions },
        { label: `Communal Surcharge (${profile.communalSurchargePercent}%)`, amount: -communalSurcharge, rate: profile.communalSurchargePercent },
        ...(specialSocialSecurityContribution > 0
            ? [{ label: 'Special Social Security Contribution (estimate)', amount: -specialSocialSecurityContribution }]
            : []),
        { label: 'Net Take-Home', amount: netTakeHome },
    ];

    return {
        grossIncome: gross,
        employeeSocialSecurity: employeeSS,
        specialSocialSecurityContribution,
        personalExemptionAmount: personalExemptionTotal,
        netIncomeAfterSS: netAfterSS,
        professionalExpenses: profExpenses,
        otherDeductionsTotal: otherDeductions,
        deductions: {
            alimonyPaid: cappedAlimony,
            personalPensionContributions: cappedPension,
            lifeInsurancePremiums: cappedLifeIns,
            mortgageInterestPaid: cappedMortgage,
            charitableDonations: cappedDonations,
            childcareCosts: cappedChildcare,
            unionDues: cappedUnion,
            medicalExpenses: cappedMedical,
        },
        taxableIncome,
        federalPITBracket1: bracket1,
        federalPITBracket2: bracket2,
        federalPITBracket3: bracket3,
        federalPITBracket4: bracket4,
        federalPITTotal: federalPIT,
        personalExemptionBenefit,
        federalTaxCredits: totalTaxCredits,
        taxReductions: effectiveTaxReductions,
        federalPITAfterReductions,
        communalSurcharge,
        totalPIT,
        totalTaxBurden,
        effectiveRate,
        marginalRate,
        netTakeHome,
        monthlyTaxReserve,
        propertyTaxEstimate,
        breakdown,
    };
}

// ──────────────────────────────────────────────────────────────────────────────
// Context
// ──────────────────────────────────────────────────────────────────────────────

const BelgianTaxProfileContext = createContext<BelgianTaxProfileContextType | undefined>(undefined);

export function BelgianTaxProfileProvider({ children }: { children: ReactNode }) {
    const [profile, setProfile] = useState<BelgianTaxProfile>(defaultProfile);
    const [isLoading, setIsLoading] = useState(true);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isFirstRender = useRef(true);

    const { value: preloaded, isLoading: preloadLoading } = usePreloadedSetting<BelgianTaxProfile>(SETTINGS_KEY);

    useEffect(() => {
        if (preloadLoading) return;
        if (preloaded) {
            setProfile({ ...defaultProfile, ...preloaded });
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
        }, 500);
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

    const calculation = computeBelgianPIT(profile);

    return (
        <BelgianTaxProfileContext.Provider value={{ profile, updateProfile, resetProfile, calculation, isLoading }}>
            {children}
        </BelgianTaxProfileContext.Provider>
    );
}

export function useBelgianTaxProfile() {
    const ctx = useContext(BelgianTaxProfileContext);
    if (!ctx) throw new Error('useBelgianTaxProfile must be used within BelgianTaxProfileProvider');
    return ctx;
}
