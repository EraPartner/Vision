/**
 * Belgian tax — year-keyed reference tables.
 *
 * All figures expressed in EUR. Income year = year income earned; assessment year = income year + 1.
 *
 * Sources: every amount below is traced to a primary source in
 * docs/reference/belgian-tax-rule-matrix.md (rule coverage matrix, one row per rule). The main
 * ones are the FPS Finance "Avis relatif à l'indexation automatique" notices for assessment years
 * 2025, 2026 and 2027 (Fisconetplus), the FPS Finance consumer pages (fin.belgium.be), the law of
 * 30 March 1994 (CSSS, arts 106-109), the law of 18 December 2025 (indexation freeze, donations
 * 30%, alimony 70/60/50%, domestic-help reduction abolished) and the law of 15 July 2026 (PIT
 * reform from AY 2027). PwC Worldwide Tax Summaries is used only as a secondary cross-check: its
 * IY 2025 dividend (859), savings (1,050) and life-insurance (2,530) figures ignore the freeze.
 * Rows marked "unverified" in the matrix (civil-servant rate, regional property tax, regional
 * own-home credits) keep their previous values pending a source.
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

interface PitBracket {
    from: number;
    to: number;
    rate: number;
}

export interface BelgianTaxYearTable {
    year: number;

    // ── Federal personal income tax brackets ────────────────────────────────
    brackets: readonly [PitBracket, PitBracket, PitBracket, PitBracket];

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
    /** Art. 51 al. 2, 1°: employees, civil servants and self-employed trading profits (winsten). */
    employeeProfessionalExpenseRate: number;
    /** Art. 51 al. 3: cap for employee remuneration and trading profits. */
    employeeProfessionalExpenseCap: number;
    directorProfessionalExpenseRate: number;
    directorProfessionalExpenseCap: number;
    /**
     * Art. 51 al. 2, 4°: degressive forfait for liberal-profession fees (baten). Rates are fixed
     * in the law (28.7% / 10% / 5% / 3%); the bracket boundaries are indexed per assessment year.
     */
    selfEmployedFeesExpenseBrackets: ReadonlyArray<PitBracket>;
    /** Art. 51 al. 3: cap for fees (same cap as helping-spouse remuneration). */
    selfEmployedFeesExpenseCap: number;

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
        // IY 2024 exemption-valuation brackets (WIB 92 art. 134 §2 al. 2): FPS indexation
        // notice AY 2025 gives 11,120 / 15,820 / 26,360 / 48,320.
        { from: 0, to: 11_120, rate: 0.25 },
        { from: 11_120, to: 15_820, rate: 0.30 },
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
    // CSSS annual scale: law of 30 March 1994 art. 108 §1, as amended by the laws of
    // 28 March 2022 and 20 November 2022 (the latter inserted the 40,997.26 cut, effective
    // 1 Jan 2022). Thresholds are not indexed, so the same values apply for IY 2024 / 2025 / 2026.
    csssTable: [
        { from: 0, to: 18_592.02, flat: 0 },
        { from: 18_592.02, to: 21_070.96, flat: 0, rate: 0.05, subtractBase: 18_592.02 },
        { from: 21_070.96, to: 37_344.00, flat: 123.95, rate: 0.013, subtractBase: 21_070.96 },
        { from: 37_344.00, to: 40_997.26, flat: 335.50, rate: 0.04009, subtractBase: 37_344.00 },
        { from: 40_997.26, to: 60_181.95, flat: 481.96, rate: 0.012996, subtractBase: 40_997.26, cap: 731.28 },
        { from: 60_181.95, to: Infinity, flat: 731.28 },
    ],
    csssTableJoint: [
        { from: 0, to: 18_592.02, flat: 0 },
        { from: 18_592.02, to: 21_070.96, flat: 0, rate: 0.05, subtractBase: 18_592.02 },
        { from: 21_070.96, to: 60_181.95, flat: 123.95, rate: 0.013, subtractBase: 21_070.96 },
        { from: 60_181.95, to: 74_688.00, flat: 632.39 },
        { from: 74_688.00, to: 81_944.00, flat: 632.39, rate: 0.013629, subtractBase: 74_688.00, cap: 731.28 },
        { from: 81_944.00, to: Infinity, flat: 731.28 },
    ],

    employeeProfessionalExpenseRate: 0.30,
    employeeProfessionalExpenseCap: 5_750,
    directorProfessionalExpenseRate: 0.03,
    directorProfessionalExpenseCap: 3_030,
    // Art. 51 al. 2, 4° (baten / profits): FPS indexation notice AY 2025.
    selfEmployedFeesExpenseBrackets: [
        { from: 0, to: 7_310, rate: 0.287 },
        { from: 7_310, to: 14_520, rate: 0.10 },
        { from: 14_520, to: 24_160, rate: 0.05 },
        { from: 24_160, to: Infinity, rate: 0.03 },
    ],
    selfEmployedFeesExpenseCap: 5_050,

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
    // Art. 145/34 al. 5: FPS indexation notice AY 2025.
    domesticHelpCap: 8_160,
    // Art. 104, 1°-2°: 80% for payments up to 31 Dec 2024 (FPS "Betaald onderhoudsgeld").
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
    // Arts 87-88 cap: FPS indexation notice AY 2025 and fin.belgium.be previous-years page.
    maritalQuotientCap: 13_050,

    // Per-transaction caps (statutory): 0.12% rate capped at €1,300; 0.35% rate capped
    // at €1,600 (NOT €4,000 — that cap belongs to the 1.32% rate only); 1.32% rate
    // capped at €4,000. Confirmed against Curvo / tob.tax / French-language retail.
    tob: {
        bonds: { rate: 0.0012, cap: 1_300 },
        sharesAndOther: { rate: 0.0035, cap: 1_600 },
        accumulatingFunds: { rate: 0.0132, cap: 4_000 },
        distributingFunds: { rate: 0.0012, cap: 1_300 },
    },

    // Art. 518 coefficient for income year 2024 (FPS indexation notice AY 2025, point H).
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
        { from: 37_344.00, to: 40_997.26, flat: 335.50, rate: 0.04009, subtractBase: 37_344.00 },
        { from: 40_997.26, to: 60_181.95, flat: 481.96, rate: 0.012996, subtractBase: 40_997.26, cap: 731.28 },
        { from: 60_181.95, to: Infinity, flat: 731.28 },
    ],
    csssTableJoint: [
        { from: 0, to: 18_592.02, flat: 0 },
        { from: 18_592.02, to: 21_070.96, flat: 0, rate: 0.05, subtractBase: 18_592.02 },
        { from: 21_070.96, to: 60_181.95, flat: 123.95, rate: 0.013, subtractBase: 21_070.96 },
        { from: 60_181.95, to: 74_688.00, flat: 632.39 },
        { from: 74_688.00, to: 81_944.00, flat: 632.39, rate: 0.013629, subtractBase: 74_688.00, cap: 731.28 },
        { from: 81_944.00, to: Infinity, flat: 731.28 },
    ],

    employeeProfessionalExpenseRate: 0.30,
    employeeProfessionalExpenseCap: 5_930,
    directorProfessionalExpenseRate: 0.03,
    directorProfessionalExpenseCap: 3_130,
    // Art. 51 al. 2, 4° (baten / profits): FPS indexation notice AY 2026.
    selfEmployedFeesExpenseBrackets: [
        { from: 0, to: 7_540, rate: 0.287 },
        { from: 7_540, to: 14_970, rate: 0.10 },
        { from: 14_970, to: 24_920, rate: 0.05 },
        { from: 24_920, to: Infinity, rate: 0.03 },
    ],
    selfEmployedFeesExpenseCap: 5_210,

    pensionSavingsCapStandard: 1_050,
    pensionSavingsRateStandard: 0.30,
    pensionSavingsCapAlternative: 1_350,
    pensionSavingsRateAlternative: 0.25,
    // Art. 145/6: frozen at the AY 2025 level by the law of 18 Dec 2025 (art. 43); FPS
    // indexation notice AY 2026 prints "2.530 — après gel: 2.450".
    lifeInsuranceCap: 2_450,
    lifeInsuranceRate: 0.30,
    groupInsuranceRate: 0.30,
    charitableDonationMin: 40,
    // Law of 18 Dec 2025 art. 67 lowered the art. 145/33 rate from 45% to 30% from AY 2026
    // (IY 2025); confirmed on fin.belgium.be "Giften".
    charitableDonationRate: 0.30,
    charitableDonationAbsoluteCap: 408_130,
    childcareDailyCap: 16.90,
    childcareRate: 0.45,
    // Art. 145/34 (domestic personnel) was abolished by the law of 18 Dec 2025 art. 68,
    // applicable from AY 2026 (art. 90). Rate 0 keeps the input harmless for IY 2025+.
    domesticHelpRate: 0,
    domesticHelpCap: 0,
    // Art. 104: 70% for alimony paid in 2025 (law of 18 Dec 2025 art. 35; FPS page).
    alimonyDeductibleFraction: 0.70,

    // Art. 21, 14°: 833 after the freeze (FPS indexation notice AY 2026 and fin.belgium.be
    // "Vrijstellingen dividenden"); PwC's 859 ignores the freeze.
    dividendExemption: 833,
    dividendWHTRate: 0.30,
    // Art. 21, 5°: 1,020 after the freeze (FPS indexation notice AY 2026; fin.belgium.be
    // "Spaargeld en beleggingen"); PwC's 1,050 ignores the freeze.
    savingsInterestExemption: 1_020,
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
    // Arts 87-88 cap: FPS indexation notice AY 2026 and fin.belgium.be "Huwelijk en samenwonen".
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

    // Art. 518 coefficient for income year 2025 (FPS indexation notice AY 2026, point H).
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
// Indexed amounts come from the FPS Finance indexation notice for AY 2027 (Fisconetplus,
// dated 3 Aug 2026), which already applies the law of 15 July 2026 reforming the PIT
// (basic exemption raised to a base of 4,945; child supplements for 1-2 children raised and
// the other supplements frozen at the AY 2026 coefficient; marital quotient cap lowered to a
// base of 5,860, or 6,365 when both spouses are 66+). The fin.belgium.be consumer pages
// still showed pre-reform IY 2026 figures (11,180 / 2,030 / 13,800) on 2026-10-11; the
// notice wins because it post-dates the published law. Items frozen by the law of
// 18 Dec 2025 (dividends 833, savings interest 1,020, life insurance 2,450, pension savings
// 1,050 / 1,350, donations cap 408,130) are unchanged from IY 2025.
// The capital-gains tax (10%, €10,000 single / €20,000 married) applies to gains REALIZED on
// or after 1 January 2026; pre-2026 gains stay exempt and FMV-at-31-Dec-2025 is the step-up
// basis for pre-2026 holdings.
// ──────────────────────────────────────────────────────────────────────────────

const TABLE_2026: BelgianTaxYearTable = {
    ...TABLE_2025,
    year: 2026,
    // Art. 518 coefficient for income year 2026 (FPS indexation notice AY 2027, point J):
    // average 2025 index 135.30 / average 1988-1989 index 58.825 = 2.3000.
    cadastralIndexationCoefficient: 2.3,
    // Art. 130 (FPS indexation notice AY 2027).
    brackets: [
        { from: 0, to: 16_720, rate: 0.25 },
        { from: 16_720, to: 29_510, rate: 0.40 },
        { from: 29_510, to: 51_070, rate: 0.45 },
        { from: 51_070, to: Infinity, rate: 0.50 },
    ],
    // Art. 134 §2 al. 2 (FPS indexation notice AY 2027).
    exemptionBrackets: [
        { from: 0, to: 11_750, rate: 0.25 },
        { from: 11_750, to: 16_720, rate: 0.30 },
        { from: 16_720, to: 27_860, rate: 0.40 },
        { from: 27_860, to: 51_070, rate: 0.45 },
        { from: 51_070, to: Infinity, rate: 0.50 },
    ],
    // Arts 131-133 after the law of 15 July 2026 (FPS indexation notice AY 2027).
    basicPersonalExemption: 11_550,
    dependentChildExemptionIncreases: [0, 2_130, 5_130, 11_440, 18_510],
    extraChildExemptionFromFifth: 7_070,
    childUnder3Supplement: 740,
    otherDependentExemption: 1_980,
    disabledSupplement: 2_030,
    isolatedParentSupplement: 1_980,
    // Art. 51 al. 3 caps and al. 2, 4° scale (FPS indexation notice AY 2027; fin.belgium.be
    // "Beroepsinkomen" gives the same 6,070 / 3,200 / 5,340).
    employeeProfessionalExpenseCap: 6_070,
    directorProfessionalExpenseCap: 3_200,
    selfEmployedFeesExpenseBrackets: [
        { from: 0, to: 7_720, rate: 0.287 },
        { from: 7_720, to: 15_340, rate: 0.10 },
        { from: 15_340, to: 25_530, rate: 0.05 },
        { from: 25_530, to: Infinity, rate: 0.03 },
    ],
    selfEmployedFeesExpenseCap: 5_340,
    // Art. 145/35 al. 6 (FPS indexation notice AY 2027; fin.belgium.be "Kinderopvang").
    childcareDailyCap: 17.30,
    // Art. 104: 60% for alimony paid in 2026 (law of 18 Dec 2025 art. 35; FPS page).
    alimonyDeductibleFraction: 0.60,
    // Arts 87-88 after the law of 15 July 2026: base 5,860 → 11,780 (FPS indexation notice
    // AY 2027). The 12,790 cap for couples where both spouses are 66+ on 1 Jan 2027 needs
    // birth years, which the profile does not carry yet; the lower cap is used.
    maritalQuotientCap: 11_780,
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
};

const TABLES: Record<number, BelgianTaxYearTable> = {
    2024: TABLE_2024,
    2025: TABLE_2025,
    2026: TABLE_2026,
};

export const SUPPORTED_TAX_YEARS = Object.keys(TABLES).map(Number).sort((a, b) => a - b);
export const LATEST_TAX_YEAR = Math.max(...SUPPORTED_TAX_YEARS);
export const EARLIEST_TAX_YEAR = Math.min(...SUPPORTED_TAX_YEARS);

function requireTable(year: number): BelgianTaxYearTable {
    const table = TABLES[year];
    if (!table) throw new Error(`Missing Belgian tax table for ${year}`);
    return table;
}

const EARLIEST_TABLE = requireTable(EARLIEST_TAX_YEAR);
const LATEST_TABLE = requireTable(LATEST_TAX_YEAR);

/**
 * Resolve the tax table for a given income year.
 *
 * Exact match when available. Otherwise: years before EARLIEST_TAX_YEAR fall back to the
 * earliest table (e.g. 2016 income → 2024 rates), years after LATEST_TAX_YEAR fall back
 * to the latest table. Callers showing historical years should display a note that
 * pre-EARLIEST values are approximated.
 */
export function getTaxTable(year: number): BelgianTaxYearTable {
    const exact = TABLES[year];
    if (exact) return exact;
    if (year < EARLIEST_TAX_YEAR) return EARLIEST_TABLE;
    return LATEST_TABLE;
}

/** True when the table for `year` is an approximation (no exact match in TABLES). */
export function isApproximatedTaxYear(year: number): boolean {
    return !TABLES[year];
}

export const DEFAULT_COMMUNAL_SURCHARGE: Record<BelgianRegion, number> = LATEST_TABLE.defaultCommunalSurcharge;
