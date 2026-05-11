/**
 * Belgian tax — year-keyed reference tables.
 *
 * All figures expressed in EUR. Income year = year income earned; assessment year = income year + 1.
 *
 * Sources (cross-checked):
 *  - PwC Worldwide Tax Summaries — Belgium — Individual (taxes on personal income, deductions, sample calc),
 *    reviewed Feb 2026.
 *  - FOD Financiën / SPF Finances published indexed amounts (Moniteur belge / Belgisch Staatsblad).
 *  - Federal "personenbelasting" / "impôt des personnes physiques" indexation tables.
 *
 * NOTE: regional tax differences (Flanders / Wallonia / Brussels) are simplified — own-home regional credits
 * (e.g. Flemish "geïntegreerde woonbonus", Brussels abattement) are not modeled here. Property tax is a
 * pragmatic estimate using regional base rate × indexed cadastral income × communal centimes additionnels.
 */

import type { BelgianRegion } from './types';

export interface CSSSTier {
    /** Annual net taxable income (single filer) lower bound */
    from: number;
    /** Annual net taxable income upper bound (use Infinity for last tier) */
    to: number;
    /** Flat annual contribution for this tier (if applicable) */
    flat?: number;
    /** Marginal rate above `subtractBase` (if applicable) */
    rate?: number;
    /** Income amount to subtract before applying `rate` */
    subtractBase?: number;
    /** Annual cap on total contribution for this tier */
    cap?: number;
}

export interface RegionPropertyTaxParams {
    /** Regional precompte rate applied to indexed cadastral income */
    baseRate: number;
    /** Communal + provincial centimes additionnels (median estimate, in percent points; e.g. 1450 means +1450%) */
    centimes: number;
}

/**
 * Special "exemption bracket" rates used to compute the personal-exemption benefit
 * (CIR-92 art. 134 §3). The exempt amount is taxed from bracket 1 upward using these
 * rates, and the result is subtracted from gross PIT.
 *
 * Per PwC's worked example for IY2025, the exemption uses 25% for the portion sitting
 * in bracket 1, and a reduced 30% for the overflow into bracket 2 (instead of the main
 * 40% rate). Higher overflow into brackets 3/4 follows the main bracket rates.
 */
export interface ExemptionBracket {
    from: number;
    to: number;
    rate: number;
}

export interface BelgianTaxYearTable {
    year: number;

    // ── Federal personal income tax brackets ────────────────────────────────
    brackets: ReadonlyArray<{ from: number; to: number; rate: number }>;

    /**
     * Bracket rates used to value the personal exemption ("quotité exemptée").
     * Bottom-up application. See ExemptionBracket doc and PwC sample calculation.
     */
    exemptionBrackets: ReadonlyArray<ExemptionBracket>;

    // ── Own-home regional credit ────────────────────────────────────────────
    /** Flemish "geïntegreerde woonbonus" base cap (interest + capital, indexed) */
    flemishWoonbonusBaseCap: number;
    /** Flemish woonbonus rate (40%) */
    flemishWoonbonusRate: number;
    /** Flemish woonbonus extra for first 10 years */
    flemishWoonbonusExtraFirst10y: number;
    /** Flemish woonbonus extra when 3+ dependent children at loan start */
    flemishWoonbonusExtraChildren: number;
    /** Walloon "chèque habitat" base annual amount (first 10 loan-years) */
    walloonChequeHabitatBase: number;
    /** Walloon chèque habitat per-dependent-child supplement */
    walloonChequeHabitatChildSupplement: number;

    // ── Personal exemptions (quotité du revenu exempté) ─────────────────────
    basicPersonalExemption: number;
    /** Indexed by number of dependent children, indexes 0..4 */
    dependentChildExemptionIncreases: ReadonlyArray<number>;
    extraChildExemptionFromFifth: number;
    childUnder3Supplement: number;
    otherDependentExemption: number;
    /** Supplement when taxpayer or spouse is disabled */
    disabledSupplement: number;
    /** Supplement for a single (isolated) parent with dependents */
    isolatedParentSupplement: number;

    // ── Social security ─────────────────────────────────────────────────────
    employeeSSRate: number;
    civilServantSSRate: number;
    /** Special social security contribution annual table (single filer) */
    csssTable: ReadonlyArray<CSSSTier>;

    // ── Professional expenses (forfait) ─────────────────────────────────────
    employeeProfessionalExpenseRate: number;
    employeeProfessionalExpenseCap: number;
    directorProfessionalExpenseRate: number;
    directorProfessionalExpenseCap: number;

    // ── Tax credits / reductions ────────────────────────────────────────────
    pensionSavingsCapStandard: number;
    pensionSavingsRateStandard: number;
    pensionSavingsCapAlternative: number;
    pensionSavingsRateAlternative: number;
    lifeInsuranceCap: number;
    lifeInsuranceRate: number;
    groupInsuranceRate: number;
    charitableDonationMin: number;
    charitableDonationRate: number;
    /** Hard EUR cap on aggregate eligible donations (10% of net income, capped) */
    charitableDonationAbsoluteCap: number;
    childcareDailyCap: number;
    childcareRate: number;
    domesticHelpRate: number;
    /** Annual cap on eligible domestic personnel wages */
    domesticHelpCap: number;
    /** Alimony deduction rate (paid to ex-spouse / dependents) */
    alimonyDeductibleFraction: number;

    // ── Investment income ───────────────────────────────────────────────────
    /** Article 21, 14° dividend exemption (reclaim via tax return) */
    dividendExemption: number;
    dividendWHTRate: number;
    /** Savings deposit interest exemption (article 21, 5°) */
    savingsInterestExemption: number;
    /** Withholding rate on interest above the savings deposit exemption */
    savingsInterestExcessRate: number;
    /** Securities account tax (TACR) rate, applied to accounts with average value ≥ threshold */
    securitiesAccountTaxRate: number;
    securitiesAccountTaxThreshold: number;

    // ── Stock exchange tax (TOB / beurstaks) ────────────────────────────────
    /** Map: instrument category → rate, cap per transaction */
    tob: {
        bonds: { rate: number; cap: number };
        sharesAndOther: { rate: number; cap: number };
        accumulatingFunds: { rate: number; cap: number };
        distributingFunds: { rate: number; cap: number };
    };

    // ── Property tax (précompte immobilier / onroerende voorheffing) ────────
    cadastralIndexationCoefficient: number;
    regionPropertyTax: Record<BelgianRegion, RegionPropertyTaxParams>;

    // ── Defaults ────────────────────────────────────────────────────────────
    defaultCommunalSurcharge: Record<BelgianRegion, number>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Income year 2024 (assessment year 2025)
// ──────────────────────────────────────────────────────────────────────────────

const TABLE_2024: BelgianTaxYearTable = {
    year: 2024,
    brackets: [
        { from: 0, to: 15_820, rate: 0.25 },
        { from: 15_820, to: 27_920, rate: 0.40 },
        { from: 27_920, to: 48_320, rate: 0.45 },
        { from: 48_320, to: Infinity, rate: 0.50 },
    ],
    exemptionBrackets: [
        // PwC sample IY2024: 25% on bracket-1 portion, reduced 30% on bracket-2 overflow.
        // Above bracket 2 the main rates apply.
        { from: 0, to: 15_820, rate: 0.25 },
        { from: 15_820, to: 27_920, rate: 0.30 },
        { from: 27_920, to: 48_320, rate: 0.45 },
        { from: 48_320, to: Infinity, rate: 0.50 },
    ],
    flemishWoonbonusBaseCap: 2_280,
    flemishWoonbonusRate: 0.40,
    flemishWoonbonusExtraFirst10y: 760,
    flemishWoonbonusExtraChildren: 80,
    walloonChequeHabitatBase: 1_520,
    walloonChequeHabitatChildSupplement: 125,
    basicPersonalExemption: 10_570,
    dependentChildExemptionIncreases: [0, 1_920, 4_950, 11_090, 17_940],
    extraChildExemptionFromFifth: 6_850,
    childUnder3Supplement: 720,
    otherDependentExemption: 1_920,
    disabledSupplement: 1_920,
    isolatedParentSupplement: 1_920,

    employeeSSRate: 0.1307,
    civilServantSSRate: 0.1107,
    csssTable: [
        { from: 0, to: 18_592.02, flat: 0 },
        { from: 18_592.02, to: 21_070.96, flat: 111.55 },
        { from: 21_070.96, to: 60_161.85, flat: 223.10, rate: 0.076, subtractBase: 21_070.96, cap: 731.28 },
        { from: 60_161.85, to: Infinity, flat: 731.28 },
    ],

    employeeProfessionalExpenseRate: 0.30,
    employeeProfessionalExpenseCap: 5_750,
    directorProfessionalExpenseRate: 0.03,
    directorProfessionalExpenseCap: 3_030,

    pensionSavingsCapStandard: 1_020,
    pensionSavingsRateStandard: 0.30,
    pensionSavingsCapAlternative: 1_310,
    pensionSavingsRateAlternative: 0.25,
    lifeInsuranceCap: 2_450,
    lifeInsuranceRate: 0.30,
    groupInsuranceRate: 0.30,
    charitableDonationMin: 40,
    charitableDonationRate: 0.45,
    charitableDonationAbsoluteCap: 397_850,
    childcareDailyCap: 16.40,
    childcareRate: 0.45,
    domesticHelpRate: 0.30,
    domesticHelpCap: 8_030,
    alimonyDeductibleFraction: 0.80,

    dividendExemption: 833,
    dividendWHTRate: 0.30,
    savingsInterestExemption: 1_020,
    savingsInterestExcessRate: 0.15,
    securitiesAccountTaxRate: 0.0015,
    securitiesAccountTaxThreshold: 1_000_000,

    tob: {
        bonds: { rate: 0.0012, cap: 1_300 },
        sharesAndOther: { rate: 0.0035, cap: 4_000 },
        accumulatingFunds: { rate: 0.0132, cap: 4_000 },
        distributingFunds: { rate: 0.0012, cap: 1_300 },
    },

    cadastralIndexationCoefficient: 2.0915,
    regionPropertyTax: {
        flanders: { baseRate: 0.0397, centimes: 1450 },
        wallonia: { baseRate: 0.0125, centimes: 4000 },
        brussels: { baseRate: 0.0125, centimes: 4500 },
    },

    defaultCommunalSurcharge: { flanders: 7, wallonia: 7.5, brussels: 7 },
};

// ──────────────────────────────────────────────────────────────────────────────
// Income year 2025 (assessment year 2026)
// ──────────────────────────────────────────────────────────────────────────────

const TABLE_2025: BelgianTaxYearTable = {
    year: 2025,
    brackets: [
        { from: 0, to: 16_320, rate: 0.25 },
        { from: 16_320, to: 28_800, rate: 0.40 },
        { from: 28_800, to: 49_840, rate: 0.45 },
        { from: 49_840, to: Infinity, rate: 0.50 },
    ],
    exemptionBrackets: [
        // PwC sample IY2025: 25% on bracket-1 portion, reduced 30% on bracket-2 overflow
        // (CIR-92 art. 134 §3). Brackets 3/4 use main rates.
        { from: 0, to: 16_320, rate: 0.25 },
        { from: 16_320, to: 28_800, rate: 0.30 },
        { from: 28_800, to: 49_840, rate: 0.45 },
        { from: 49_840, to: Infinity, rate: 0.50 },
    ],
    flemishWoonbonusBaseCap: 2_280,
    flemishWoonbonusRate: 0.40,
    flemishWoonbonusExtraFirst10y: 760,
    flemishWoonbonusExtraChildren: 80,
    walloonChequeHabitatBase: 1_520,
    walloonChequeHabitatChildSupplement: 125,
    basicPersonalExemption: 10_910,
    dependentChildExemptionIncreases: [0, 1_980, 5_110, 11_440, 18_510],
    extraChildExemptionFromFifth: 7_070,
    childUnder3Supplement: 740,
    otherDependentExemption: 1_980,
    disabledSupplement: 1_980,
    isolatedParentSupplement: 1_980,

    employeeSSRate: 0.1307,
    civilServantSSRate: 0.1107,
    csssTable: [
        { from: 0, to: 18_592.02, flat: 0 },
        { from: 18_592.02, to: 21_070.96, flat: 111.55 },
        { from: 21_070.96, to: 60_161.85, flat: 223.10, rate: 0.076, subtractBase: 21_070.96, cap: 731.28 },
        { from: 60_161.85, to: Infinity, flat: 731.28 },
    ],

    employeeProfessionalExpenseRate: 0.30,
    employeeProfessionalExpenseCap: 5_930,
    directorProfessionalExpenseRate: 0.03,
    directorProfessionalExpenseCap: 3_130,

    pensionSavingsCapStandard: 1_050,
    pensionSavingsRateStandard: 0.30,
    pensionSavingsCapAlternative: 1_350,
    pensionSavingsRateAlternative: 0.25,
    lifeInsuranceCap: 2_530,
    lifeInsuranceRate: 0.30,
    groupInsuranceRate: 0.30,
    charitableDonationMin: 40,
    charitableDonationRate: 0.45,
    charitableDonationAbsoluteCap: 419_820,
    childcareDailyCap: 16.90,
    childcareRate: 0.45,
    domesticHelpRate: 0.30,
    domesticHelpCap: 8_290,
    alimonyDeductibleFraction: 0.80,

    dividendExemption: 859,
    dividendWHTRate: 0.30,
    savingsInterestExemption: 1_050,
    savingsInterestExcessRate: 0.15,
    securitiesAccountTaxRate: 0.0015,
    securitiesAccountTaxThreshold: 1_000_000,

    tob: {
        bonds: { rate: 0.0012, cap: 1_300 },
        sharesAndOther: { rate: 0.0035, cap: 4_000 },
        accumulatingFunds: { rate: 0.0132, cap: 4_000 },
        distributingFunds: { rate: 0.0012, cap: 1_300 },
    },

    cadastralIndexationCoefficient: 2.1763,
    regionPropertyTax: {
        flanders: { baseRate: 0.0397, centimes: 1450 },
        wallonia: { baseRate: 0.0125, centimes: 4000 },
        brussels: { baseRate: 0.0125, centimes: 4500 },
    },

    defaultCommunalSurcharge: { flanders: 7, wallonia: 7.5, brussels: 7 },
};

const TABLES: Record<number, BelgianTaxYearTable> = {
    2024: TABLE_2024,
    2025: TABLE_2025,
};

export const SUPPORTED_TAX_YEARS = Object.keys(TABLES).map(Number).sort((a, b) => a - b);
export const LATEST_TAX_YEAR = Math.max(...SUPPORTED_TAX_YEARS);
export const EARLIEST_TAX_YEAR = Math.min(...SUPPORTED_TAX_YEARS);

/**
 * Resolve the tax table for a given income year.
 *
 * Exact match when available. Otherwise: years before EARLIEST_TAX_YEAR fall back to the
 * earliest table (e.g. 2016 income → 2024 rates), years after LATEST_TAX_YEAR fall back
 * to the latest table. Callers showing historical years should display a note that
 * pre-EARLIEST values are approximated.
 */
export function getTaxTable(year: number): BelgianTaxYearTable {
    if (TABLES[year]) return TABLES[year];
    if (year < EARLIEST_TAX_YEAR) return TABLES[EARLIEST_TAX_YEAR];
    return TABLES[LATEST_TAX_YEAR];
}

/** True when the table for `year` is an approximation (no exact match in TABLES). */
export function isApproximatedTaxYear(year: number): boolean {
    return !TABLES[year];
}

// ──────────────────────────────────────────────────────────────────────────────
// Backwards-compatible top-level constants (latest year).
// New code should prefer `getTaxTable(year)` for year-aware values.
// ──────────────────────────────────────────────────────────────────────────────

const LATEST = TABLES[LATEST_TAX_YEAR];

export const BELGIAN_TAX_BRACKETS = LATEST.brackets;
export const EMPLOYEE_SS_RATE = LATEST.employeeSSRate;
export const LUMP_SUM_PROFESSIONAL_EXPENSE_RATE = LATEST.employeeProfessionalExpenseRate;
export const LUMP_SUM_PROFESSIONAL_EXPENSE_CAP = LATEST.employeeProfessionalExpenseCap;
export const DIRECTOR_PROFESSIONAL_EXPENSE_RATE = LATEST.directorProfessionalExpenseRate;
export const DIRECTOR_PROFESSIONAL_EXPENSE_CAP = LATEST.directorProfessionalExpenseCap;
export const BASIC_PERSONAL_EXEMPTION = LATEST.basicPersonalExemption;
export const DEPENDENT_CHILD_EXEMPTION_INCREASES = LATEST.dependentChildExemptionIncreases;
export const EXTRA_CHILD_EXEMPTION_FROM_FIFTH = LATEST.extraChildExemptionFromFifth;
export const OTHER_DEPENDENT_EXEMPTION = LATEST.otherDependentExemption;
export const PENSION_SAVINGS_CAP_STANDARD = LATEST.pensionSavingsCapStandard;
export const PENSION_SAVINGS_CAP_ALTERNATIVE = LATEST.pensionSavingsCapAlternative;
export const LIFE_INSURANCE_CAP = LATEST.lifeInsuranceCap;
export const CHARITABLE_DONATION_MIN = LATEST.charitableDonationMin;
export const CHILDCARE_DAILY_CAP = LATEST.childcareDailyCap;
/** @deprecated use `CHILDCARE_DAILY_CAP` (year-aware via getTaxTable) */
export const CHILDCARE_DAILY_CAP_2025 = LATEST.childcareDailyCap;
export const BELGIAN_DIVIDEND_EXEMPTION = LATEST.dividendExemption;
export const BELGIAN_DIVIDEND_WHT_RATE = LATEST.dividendWHTRate;

export const DEFAULT_COMMUNAL_SURCHARGE: Record<BelgianRegion, number> = LATEST.defaultCommunalSurcharge;
