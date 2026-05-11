/**
 * Belgian tax — year-keyed reference tables.
 *
 * All figures expressed in EUR. Income year = year income earned; assessment year = income year + 1.
 *
 * Sources (cross-checked):
 *  - PwC Worldwide Tax Summaries — Belgium — Individual (taxes on personal income, deductions, sample calc),
 *    reviewed May 2026.
 *  - FOD Financiën / SPF Finances published indexed amounts (Moniteur belge / Belgisch Staatsblad).
 *  - Federal "personenbelasting" / "impôt des personnes physiques" indexation tables.
 *  - "Law Miscellaneous of 11 December 2025" — charitable donation reduction lowered from 45% to 30%
 *    as from assessment year 2026 (income year 2025).
 *  - Partena Professional infoflashes — cadastral income indexation coefficients (IY 2024 = 2.1763,
 *    IY 2025 = 2.2446).
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
 * Service-voucher (dienstencheques / titres-services) regional credit parameters.
 *
 * Three different shapes are used across regions:
 *  - `rate`: percentage of voucher cost taken as tax reduction (Brussels 15%)
 *  - `amountPerVoucher`: fixed EUR per voucher (Wallonia €0.90)
 *  - `maxCount`: cap on number of vouchers eligible
 *  - `voucherPrice`: face value (used when rate-based; defaults to €10)
 */
export interface ServiceVoucherRegionalParams {
    rate: number;
    amountPerVoucher: number;
    maxCount: number;
    voucherPrice: number;
}

/**
 * Special "exemption bracket" table used to value the personal exemption
 * (CIR-92 art. 134 §3). The exempt amount is taxed from the lowest bracket upward
 * using these rates, and the result is subtracted from gross PIT.
 *
 * IMPORTANT: This is a SEPARATE indexed table — it does NOT share boundaries with
 * the standard PIT brackets. PwC's published sample calculation for IY 2025 confirms
 * the boundaries: 25% (0–11,460), 30% (11,460–16,320), 40% (16,320–27,190),
 * 45% (27,190–49,840), 50% (49,840+). The 11,460 and 27,190 inner boundaries are
 * specific to this valuation table and unrelated to the main PIT bracket cuts
 * (which run 16,320 / 28,800 / 49,840 for IY 2025).
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
    /** "Ordinary" Flemish woonbonus base cap — applies to loans signed BEFORE 2016 (indexed) */
    flemishWoonbonusBaseCap: number;
    /**
     * "Geïntegreerde" Vlaamse woonbonus base cap — applies to loans signed 2016-2019 (indexed).
     * Lower than the pre-2016 base because the 2016 reform merged housing & ordinary credit
     * regimes into a single, reduced-cap scheme. Per Wikifin / Circulaire 2025/C/35.
     */
    flemishIntegratedWoonbonusBaseCap: number;
    /** Flemish woonbonus rate (40%) — same for both pre-2016 and 2016-2019 regimes */
    flemishWoonbonusRate: number;
    /** Flemish woonbonus extra for first 10 years — same for both regimes */
    flemishWoonbonusExtraFirst10y: number;
    /** Flemish woonbonus extra when 3+ dependent children at loan start — same for both regimes */
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
    /**
     * Special social security contribution annual table — SINGLE filer (`gemeenschappelijke
     * aanslag = nee`). Post 1 April 2022 reform; thresholds are NOT indexed.
     */
    csssTable: ReadonlyArray<CSSSTier>;
    /**
     * Special social security contribution annual table — JOINT filer (married /
     * legal cohabiting, `gemeenschappelijke aanslag`). Same floor as single but flatter
     * progression; cap is the household maximum €731.28.
     */
    csssTableJoint: ReadonlyArray<CSSSTier>;

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

    /**
     * Capital gains tax on financial assets (Arizona reform). Applies to gains realized on or
     * after **1 January 2026**. The law (approved 3 April 2026 and published in the Belgian
     * Official Gazette shortly after) defers broker-level withholding to 1 June 2026, but the
     * taxable event for the full-year liability runs from 1 Jan 2026. Zero for IY 2025 and
     * earlier — pre-2026 realizations stay exempt.
     *
     * From IY 2026:
     *  - `capitalGainsTaxRate`: flat 10% on realized gains in excess of the exemption.
     *  - `capitalGainsTaxExemptionSingle` / `capitalGainsTaxExemptionMarried`: €10,000 single /
     *    €20,000 per household, indexed annually.
     *
     * NOT modeled (would require per-transaction date awareness + multi-year carryforward state):
     *  - Step-up basis: fair market value at 31 Dec 2025 is the deemed acquisition value for
     *    pre-2026 holdings; gains accrued before 2026 stay exempt.
     *  - 5-year carryforward: when less than 10% of the annual exemption is used, the unused
     *    portion rolls forward at +€1,000 / +€2,000 per year (single / married), cumulative cap
     *    €5,000 / €10,000 so the maximum annual exemption can grow to €15,000 / €30,000 after
     *    five unused years (FIFO).
     *  - 33% rate on gains outside normal-management private estate (large stakes, frequent
     *    speculation) — separate from the 10% default.
     */
    capitalGainsTaxRate: number;
    capitalGainsTaxExemptionSingle: number;
    capitalGainsTaxExemptionMarried: number;

    /**
     * Reynders tax — flat 30% on the interest-attributable portion of gains from bond /
     * mixed funds (>10% bonds). Applies on sale/redemption. Always-on since the late 2000s;
     * 2026 CGT reform retained Reynders on the bond portion while the new 10% CGT covers
     * the non-bond remainder.
     *
     * `reyndersBondThreshold` is informational (the 10% bond-share trigger). Set 0 to disable.
     */
    reyndersTaxRate: number;
    reyndersBondThreshold: number;

    // ── Marital quotient ────────────────────────────────────────────────────
    /** Fraction of higher-earner professional income transferred to lower-earning spouse. */
    maritalQuotientRate: number;
    /** Absolute cap on the transferred amount (EUR). */
    maritalQuotientCap: number;

    // ── Stock exchange tax (TOB / beurstaks) ────────────────────────────────
    /** Map: instrument category → rate, cap per transaction */
    tob: {
        bonds: { rate: number; cap: number };
        sharesAndOther: { rate: number; cap: number };
        accumulatingFunds: { rate: number; cap: number };
        distributingFunds: { rate: number; cap: number };
    };

    /**
     * Federal/regional autonomy multiplier applied to federal PIT after credits before
     * the communal surcharge. Belgium's regional-autonomy mechanism: the federal
     * government applies a ~24.95% reduction to PIT and the regions add back a regional
     * surtax. Net effect is ~0.49% saving (Flanders, PwC AY 2026 sample). Per-region
     * factor allows modeling Wallonia / Brussels separately when authoritative figures
     * land; calibrated default ~0.9951.
     */
    regionalAutonomyFactor: Record<BelgianRegion, number>;

    // ── Property tax (précompte immobilier / onroerende voorheffing) ────────
    cadastralIndexationCoefficient: number;
    regionPropertyTax: Record<BelgianRegion, RegionPropertyTaxParams>;

    // ── Service vouchers (regional) ─────────────────────────────────────────
    serviceVoucherRegional: Record<BelgianRegion, ServiceVoucherRegionalParams>;

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
        // IY 2024 exemption-valuation brackets. Inner boundaries (11,110 and 26,360) are
        // de-indexed estimates from the PwC-confirmed IY 2025 figures (11,460 / 27,190)
        // using the published 3.15% bracket indexation step. FOD Financiën publishes the
        // exact AY 2025 values; substitute when verified.
        { from: 0, to: 11_110, rate: 0.25 },
        { from: 11_110, to: 15_820, rate: 0.30 },
        { from: 15_820, to: 26_360, rate: 0.40 },
        { from: 26_360, to: 48_320, rate: 0.45 },
        { from: 48_320, to: Infinity, rate: 0.50 },
    ],
    flemishWoonbonusBaseCap: 2_280,
    flemishIntegratedWoonbonusBaseCap: 1_520,
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
    // CSSS thresholds reset by Programmawet of 1 Apr 2022 (mini-taxshift) — singles tier 3
    // dropped from 7.6% to 1.3%, tier 2 from 9% flat to 5% rate-based. Thresholds are not
    // indexed, so the same values apply for IY 2024 / 2025 / 2026.
    csssTable: [
        { from: 0, to: 18_592.02, flat: 0 },
        { from: 18_592.02, to: 21_070.96, flat: 0, rate: 0.05, subtractBase: 18_592.02 },
        { from: 21_070.96, to: 37_344.00, flat: 123.95, rate: 0.013, subtractBase: 21_070.96 },
        { from: 37_344.00, to: 47_215.31, flat: 335.50, rate: 0.04009, subtractBase: 37_344.00, cap: 731.28 },
        { from: 47_215.31, to: Infinity, flat: 731.28 },
    ],
    csssTableJoint: [
        { from: 0, to: 18_592.02, flat: 0 },
        { from: 18_592.02, to: 21_070.96, flat: 0, rate: 0.05, subtractBase: 18_592.02 },
        { from: 21_070.96, to: 60_181.95, flat: 123.95, rate: 0.013, subtractBase: 21_070.96 },
        { from: 60_181.95, to: 74_688.00, flat: 632.39 },
        { from: 74_688.00, to: 81_944.96, flat: 632.39, rate: 0.013629, subtractBase: 74_688.00, cap: 731.28 },
        { from: 81_944.96, to: Infinity, flat: 731.28 },
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
    charitableDonationAbsoluteCap: 408_130,
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

    // Capital gains tax on financial assets enters force 1 Jan 2026 — no CGT for IY 2024.
    capitalGainsTaxRate: 0,
    capitalGainsTaxExemptionSingle: 0,
    capitalGainsTaxExemptionMarried: 0,

    reyndersTaxRate: 0.30,
    reyndersBondThreshold: 0.10,

    maritalQuotientRate: 0.30,
    // IY 2024 cap — typical year-over-year indexation from prior years. Authoritative value
    // can be substituted once the published 'huwelijksquotiënt' table for AY 2025 is verified.
    maritalQuotientCap: 13_070,

    // Per-transaction caps (statutory): 0.12% rate capped at €1,300; 0.35% rate capped
    // at €1,600 (NOT €4,000 — that cap belongs to the 1.32% rate only); 1.32% rate
    // capped at €4,000. Confirmed against Curvo / tob.tax / French-language retail.
    tob: {
        bonds: { rate: 0.0012, cap: 1_300 },
        sharesAndOther: { rate: 0.0035, cap: 1_600 },
        accumulatingFunds: { rate: 0.0132, cap: 4_000 },
        distributingFunds: { rate: 0.0012, cap: 1_300 },
    },

    cadastralIndexationCoefficient: 2.1763,
    // Centimes additionnels (communal + provincial) — Belgium-wide median estimates
    // chosen so total tax (baseRate × (1 + centimes/100)) lands inside PwC's typical
    // 20–50% of indexed CI range for most communes. Flanders has a higher base rate,
    // so its centimes median is lower than Wallonia/Brussels.
    regionPropertyTax: {
        flanders: { baseRate: 0.0397, centimes: 1100 },
        wallonia: { baseRate: 0.0125, centimes: 3300 },
        brussels: { baseRate: 0.0125, centimes: 4200 },
    },

    regionalAutonomyFactor: {
        flanders: 0.9951,
        wallonia: 0.9951,
        brussels: 0.9951,
    },

    serviceVoucherRegional: {
        // Flanders still ran the 20%-style federal-derived reduction in IY 2024;
        // abolished from 1 Jan 2025. €0.90 here is the Walloon shape and not used.
        flanders:  { rate: 0.20, amountPerVoucher: 0,    maxCount: 168, voucherPrice: 9 },
        wallonia:  { rate: 0,    amountPerVoucher: 0.90, maxCount: 150, voucherPrice: 9 },
        brussels:  { rate: 0.15, amountPerVoucher: 0,    maxCount: 172, voucherPrice: 10 },
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
        // IY 2025 exemption-valuation table (PwC AY 2026 sample, verified verbatim):
        //   25% on 0–11,460 / 30% on 11,460–16,320 / 40% on 16,320–27,190 /
        //   45% on 27,190–49,840 / 50% above 49,840.
        // The 11,460 and 27,190 inner cuts are SEPARATE indexed amounts — not the
        // PIT bracket boundaries. Using the PIT brackets here understates the
        // exemption benefit for any household whose total exemption exceeds 11,460
        // (i.e. anyone with 2+ children, isolated parent, etc.).
        { from: 0, to: 11_460, rate: 0.25 },
        { from: 11_460, to: 16_320, rate: 0.30 },
        { from: 16_320, to: 27_190, rate: 0.40 },
        { from: 27_190, to: 49_840, rate: 0.45 },
        { from: 49_840, to: Infinity, rate: 0.50 },
    ],
    flemishWoonbonusBaseCap: 2_280,
    flemishIntegratedWoonbonusBaseCap: 1_520,
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
    // CSSS thresholds are not indexed — identical to IY 2024.
    csssTable: [
        { from: 0, to: 18_592.02, flat: 0 },
        { from: 18_592.02, to: 21_070.96, flat: 0, rate: 0.05, subtractBase: 18_592.02 },
        { from: 21_070.96, to: 37_344.00, flat: 123.95, rate: 0.013, subtractBase: 21_070.96 },
        { from: 37_344.00, to: 47_215.31, flat: 335.50, rate: 0.04009, subtractBase: 37_344.00, cap: 731.28 },
        { from: 47_215.31, to: Infinity, flat: 731.28 },
    ],
    csssTableJoint: [
        { from: 0, to: 18_592.02, flat: 0 },
        { from: 18_592.02, to: 21_070.96, flat: 0, rate: 0.05, subtractBase: 18_592.02 },
        { from: 21_070.96, to: 60_181.95, flat: 123.95, rate: 0.013, subtractBase: 21_070.96 },
        { from: 60_181.95, to: 74_688.00, flat: 632.39 },
        { from: 74_688.00, to: 81_944.96, flat: 632.39, rate: 0.013629, subtractBase: 74_688.00, cap: 731.28 },
        { from: 81_944.96, to: Infinity, flat: 731.28 },
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
    // Law Miscellaneous of 11 Dec 2025 lowered the rate from 45% → 30% as from AY 2026 (IY 2025).
    charitableDonationRate: 0.30,
    charitableDonationAbsoluteCap: 408_130,
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

    // CGT on financial assets enters force 1 Jan 2026 — still 0 for income earned in 2025.
    capitalGainsTaxRate: 0,
    capitalGainsTaxExemptionSingle: 0,
    capitalGainsTaxExemptionMarried: 0,

    reyndersTaxRate: 0.30,
    reyndersBondThreshold: 0.10,

    maritalQuotientRate: 0.30,
    // AY 2026 (IY 2025) — KPMG / Vialto / Loyens & Loeff confirm €13,460.
    maritalQuotientCap: 13_460,

    // Per-transaction caps (statutory): see IY 2024 table for rationale. Cap is a
    // function of the rate, not the instrument: 0.12% → €1,300; 0.35% → €1,600;
    // 1.32% → €4,000.
    tob: {
        bonds: { rate: 0.0012, cap: 1_300 },
        sharesAndOther: { rate: 0.0035, cap: 1_600 },
        accumulatingFunds: { rate: 0.0132, cap: 4_000 },
        distributingFunds: { rate: 0.0012, cap: 1_300 },
    },

    cadastralIndexationCoefficient: 2.2446,
    regionPropertyTax: {
        flanders: { baseRate: 0.0397, centimes: 1100 },
        wallonia: { baseRate: 0.0125, centimes: 3300 },
        brussels: { baseRate: 0.0125, centimes: 4200 },
    },

    // Calibrated from PwC AY 2026 sample (Flanders, single-earner married couple):
    // subtotal × 0.9951 ≈ combined state + regional tax. Wallonia mirrors Flanders;
    // Brussels uses 0.9945 per ADR-056 (slightly steeper Brussels-specific regional
    // surcharge net of the federal release).
    regionalAutonomyFactor: {
        flanders: 0.9951,
        wallonia: 0.9951,
        brussels: 0.9945,
    },

    serviceVoucherRegional: {
        // Flanders abolished the dienstencheques reduction for vouchers purchased from 1 Jan 2025.
        flanders:  { rate: 0,    amountPerVoucher: 0,    maxCount: 0,   voucherPrice: 10 },
        wallonia:  { rate: 0,    amountPerVoucher: 0.90, maxCount: 150, voucherPrice: 10 },
        // Brussels: 15% reduction on first 172 vouchers, voucher face value €10. No
        // sunset has been published as of audit date — keep until Brussels government
        // formally repeals.
        brussels:  { rate: 0.15, amountPerVoucher: 0,    maxCount: 172, voucherPrice: 10 },
    },

    defaultCommunalSurcharge: { flanders: 7, wallonia: 7.5, brussels: 7 },
};

// ──────────────────────────────────────────────────────────────────────────────
// Income year 2026 (assessment year 2027)
//
// Brackets/indexed amounts copied forward from IY 2025 — FPS Finance has not yet published
// the IY 2026 indexation. Values will be approximated to IY 2025 until the official tables
// land in the Belgian Official Gazette (typically October–December 2025 publication, often
// retroactive to 1 January). The capital-gains tax is the only IY 2026-specific change
// that is in force: 10% rate, €10,000 single / €20,000 married annual exemption, applied
// to gains REALIZED on or after 1 January 2026 (the law was passed 3 April 2026; broker-level
// withholding starts 1 June 2026 but the taxable event covers the full year). Pre-1-Jan-2026
// gains stay exempt; FMV-at-31-Dec-2025 acts as the step-up basis for pre-2026 holdings.
// ──────────────────────────────────────────────────────────────────────────────

const TABLE_2026: BelgianTaxYearTable = {
    ...TABLE_2025,
    year: 2026,
    // Cap-gains tax on financial assets — Arizona reform. Realization-based: applies to gains
    // realized on or after 1 January 2026. Step-up basis (FMV at 31 Dec 2025) and 5-year
    // €1k/year carryforward of unused exemption are documented in the BelgianTaxYearTable
    // CGT docstring; not modeled in the current pipeline.
    capitalGainsTaxRate: 0.10,
    capitalGainsTaxExemptionSingle: 10_000,
    capitalGainsTaxExemptionMarried: 20_000,
    // Reynders survives the 2026 reform; rate unchanged at 30% on the bond-attributable portion.
    reyndersTaxRate: 0.30,
    reyndersBondThreshold: 0.10,
    // Marital quotient: phase-out begins AY 2027 (IY 2026). Reform halves benefit over 4 years
    // and freezes indexation; until the implementing law is published, model uses the IY 2025 cap.
    maritalQuotientCap: TABLE_2025.maritalQuotientCap,
};

const TABLES: Record<number, BelgianTaxYearTable> = {
    2024: TABLE_2024,
    2025: TABLE_2025,
    2026: TABLE_2026,
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
