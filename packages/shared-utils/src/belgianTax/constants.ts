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
 * Regional rules (own-home credits, service vouchers, the state/regional factor) come from the
 * regional versions of WIB 92 on Fisconetplus and the FPS circulars cited next to each value.
 * Rows marked "unverified" in the matrix (Walloon and Brussels property-tax centimes) keep their
 * previous values pending a source.
 *
 * NOTE: Brussels own-home advantages (abattement on registration duties) are not modelled. Property
 * tax is a pragmatic estimate using regional base rate × indexed cadastral income × communal
 * centimes additionnels.
 */

import type { BelgianRegion } from './types.ts';

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
 * Service-voucher (dienstencheques / titres-services) regional reduction parameters, WIB 92
 * art. 145/21 in its regional versions: the reduction is `rate` × the expenses paid, the
 * expenses being capped at `spendCap` per taxpayer ("uitgaven tot ten hoogste … per
 * belastingplichtige"). A region that abolished the reduction has `rate` 0 and `spendCap` 0.
 *
 * `voucherPrice` only converts the legacy `serviceVoucherCount` input into an expense amount when
 * no `serviceVoucherSpend` is entered; it is the engine's earlier face-value assumption, not a
 * sourced amount.
 */
export interface ServiceVoucherRegionalParams {
    rate: number;
    spendCap: number;
    voucherPrice: number;
}

/**
 * Self-employed social contribution parameters (RSZ for the self-employed, RSVZ / INASTI), Royal
 * Decree no. 38 of 27 July 1967 art. 12 §1 (main occupation, before pension age): `rate1` on the
 * income up to `threshold1`, computed on at least `minimumIncome`; `rate2` on the part between
 * `threshold1` and `threshold2`; nothing above `threshold2`. The thresholds are the base amounts
 * of art. 12 §1 (15,831.12 / 23,330.06 / 3,666.15 at index 142.75) multiplied by the art. 14 §1
 * fraction fixed every year by royal decree.
 */
export interface SelfEmployedContributionParams {
    rate1: number;
    rate2: number;
    threshold1: number;
    threshold2: number;
    minimumIncome: number;
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
/**
 * Reduction for pensions (WIB 92 arts 146-153; "pensioenen" of art. 146, 1°, i.e. art. 34
 * income). Amounts are the FPS indexation notice figures (art. 178 §3) per assessment year.
 */
export interface PensionReductionParams {
    /** Art. 147 al. 1, 1°: basisvermindering when the net income consists only of pensions. */
    base: number;
    /**
     * Art. 147 al. 1, 1°: aanvullende vermindering; for AY 2025 and 2026 the amount raised by
     * royal decree under art. 147 al. 4 (KB/WIB 92 art. 63^18/18).
     */
    additional: number;
    /** Art. 151/1: the additional reduction is granted in full up to `lower`, not from `upper`. */
    additionalLimits: { lower: number; upper: number };
    /**
     * Art. 147 al. 1, 2°, b-c and al. 3: limits of the gross statutory pension (FPS circular
     * AAFisc 40/2011 no. 22) received from the legal pension age. Up to `lower` the activity
     * income is left out of the pension proportion in full; between `lower` and `upper` in part,
     * (upper − pension) / difference; above `upper` not at all. Same base amounts
     * (10,160 / 14,900) and indexed values as `additionalLimits`, but a different rule.
     * `difference` is the al. 3 "Différence" that the FPS indexation notice publishes as an
     * amount of its own (base 4,740, indexed separately); it can differ from `upper − lower`.
     */
    statutoryPensionLimits: { lower: number; upper: number; difference: number };
    /**
     * Art. 152 (to AY 2026) / art. 151/2 al. 4 (from AY 2027): the base reduction is granted in
     * full up to `lower` and tapers to one third at `upper`.
     */
    baseLimits: { lower: number; upper: number };
    /**
     * Art. 151/2 al. 1-3 (from AY 2027): one third up to `from`, tapering to nothing at `to`
     * ("meer dan" `to`: none). Absent before IY 2026, when art. 152 keeps one third.
     */
    baseZeroLimits?: { from: number; to: number };
}

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
    // Flemish amounts are not indexed: "de bedragen bedoeld in de artikelen 145/37 tot en met
    // 145/46, worden niet geïndexeerd, cf. art. 178, § 5, 4°, WIB 92 (Vlaams Gewest)".
    /** Flemish woonbonus base cap for loans signed before 1 Jan 2015 (WIB 92 Flemish art. 145/37 §2). */
    flemishWoonbonusBaseCap: number;
    /** Flemish woonbonus base cap for loans signed in 2015 (WIB 92 Flemish art. 145/37 §3). */
    flemishWoonbonus2015BaseCap: number;
    /** "Geïntegreerde" woonbonus base cap for loans signed 2016-2019 (WIB 92 Flemish art. 145/38/2 §2). */
    flemishIntegratedWoonbonusBaseCap: number;
    /** Flemish woonbonus rate for loans signed from 2015 (art. 145/37 §3, art. 145/38/2 §3). */
    flemishWoonbonusRate: number;
    /**
     * Minimum rate for loans signed before 2015: the reduction is computed at the taxpayer's
     * highest art. 130 rate "met een minimum van 30 %" (art. 145/37 §2).
     */
    flemishWoonbonusPre2015MinimumRate: number;
    /** Increase of the base cap during the first ten taxable periods (art. 145/37 §2-3, 145/38/2 §2). */
    flemishWoonbonusExtraFirst10y: number;
    /** Further increase for 3+ dependent children, on top of the first-ten-years increase. */
    flemishWoonbonusExtraChildren: number;
    /** Walloon "chèque habitat" amount at or below the lower income threshold (art. 145/46ter §2, not indexed). */
    walloonChequeHabitatBase: number;
    /** Walloon chèque habitat increase per dependent child (art. 145/46ter §2 al. 2, not indexed). */
    walloonChequeHabitatChildSupplement: number;
    /**
     * Art. 145/46ter §2 income limits (base 21,000 / 81,000), indexed under art. 178 §6bis.
     * The "revenu imposable" is that of art. 6 without non-professional movable income.
     */
    walloonChequeHabitatIncomeThresholds: { lower: number; upper: number };
    /** Art. 145/46ter §2, 2°: coefficient of 1.275% applied to the income above the lower limit. */
    walloonChequeHabitatPhaseOutRate: number;

    // ── Reduction for pensions (arts 146-153) ───────────────────────────────
    pensionReduction: PensionReductionParams;

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
    /** RSVZ contribution scale for a main-occupation self-employed person (calendar year). */
    selfEmployedContributions: SelfEmployedContributionParams;
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
    /**
     * Art. 51 al. 2, 3°: forfait rate for helping-spouse remuneration (5%), capped with
     * `selfEmployedFeesExpenseCap` (art. 51 al. 3). Rule matrix row "Helping spouse: 5%, capped".
     */
    helpingSpouseProfessionalExpenseRate: number;

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
     * Capital gains tax on financial assets: law of 6 April 2026 (BS 21.04.2026, numac
     * 2026002780), in force from 1 January 2026 (art. 35), commented in FPS circular 2026/C/74.
     * Applies to gains realized on or after **1 January 2026**. Zero for IY 2025 and earlier —
     * pre-2026 realizations stay exempt.
     *
     * From IY 2026:
     *  - `capitalGainsTaxRate`: 10% (art. 171, 2°, e) WIB 92, restored by art. 14 of the law),
     *    without communal surcharge.
     *  - Exemption of art. 96/2, 2°: base 4,855, indexed to €10,000 for AY 2027 (N27), **per
     *    taxpayer**. `capitalGainsTaxExemptionMarried` is therefore 2 × 10,000 for two spouses;
     *    it is not a household carry-forward amount.
     *
     * NOT modeled (would require per-transaction date awareness + multi-year state):
     *  - Step-up basis: fair market value at 31 Dec 2025 is the deemed acquisition value for
     *    pre-2026 holdings; gains accrued before 2026 stay exempt.
     *  - Carry-forward of art. 96/2, 3°: per taxpayer, an extra exempt slice (base 480, set at
     *    exactly €1,000 for AY 2028 by royal decree) for each year without realised gains; the
     *    extra slices used in one taxable period are capped at base 2,426 ("niet meer bedragen
     *    dan 2.426 euro"). Circular 2026/C/74 nos. 93-97.
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
    /**
     * Arts 87-88 cap when both spouses have reached 66 on 1 January of the assessment year
     * (law of 15 July 2026 arts 27 and 30, A, from AY 2027). Absent before IY 2026.
     */
    maritalQuotientCapBothSenior?: number;
    /**
     * Art. 126 §2 al. 1, 4°: treaty-exempt professional income above which spouses are assessed
     * separately ("meer dan"). Equal to the basic exemption from AY 2027 (L2 art. 32).
     */
    treatyExemptSeparateThreshold: number;
    /**
     * Art. 134 §3: ceiling per dependent child of the refundable child tax credit (550, no longer
     * indexed per the law of 18 Dec 2025 art. 42). Stored only: the credit formula is an open item.
     */
    refundableChildCreditCapPerChild: number;

    // ── Stock exchange tax (TOB / beurstaks) ────────────────────────────────
    /** Map: instrument category → rate, cap per transaction */
    tob: {
        bonds: { rate: number; cap: number };
        sharesAndOther: { rate: number; cap: number };
        accumulatingFunds: { rate: number; cap: number };
        distributingFunds: { rate: number; cap: number };
    };

    /**
     * Combined state + regional factor applied to the PIT after reductions, before the communal
     * surcharge: (1 − autonomy factor) × (1 + regional opcentiemen). The autonomy factor is
     * 24.957% from AY 2018 (Royal Decree of 19 Dec 2017; special finance law of 16 Jan 1989
     * art. 5/2), so the reduced state tax is 75.043%. Regional opcentiemen: Wallonia 33.257%
     * (Walloon decree of 13 Dec 2017 art. 33), Flanders 33.257% (equal to the default of special
     * finance law art. 81quater, 1°: 0.24957 / 0.75043) and Brussels 32.591% (Brussels Finance
     * Minister's answer to written question no. 104, October 2025). Products:
     * 0.75043 × 1.33257 = 1.0000 and 0.75043 × 1.32591 = 0.9950. Regional tax reductions are
     * not part of this factor.
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
    // Flemish woonbonus: WIB 92 Flemish arts 145/37 §2-3 and 145/38/2 §2-3 (Fisconetplus
    // 2cea1dd2-9260-4e01-a287-7407c9d1884b, 4de78004-13bc-4858-b519-4312c09f38c8); the same
    // 2,280 / 1,520 / 760 / 80 amounts appear in the FPS circulars for AY 2024-2026
    // (2026/C/63 for AY 2026). Frozen: not indexed (art. 178 §5, 4°, Flemish version).
    flemishWoonbonusBaseCap: 2_280,
    flemishWoonbonus2015BaseCap: 1_520,
    flemishIntegratedWoonbonusBaseCap: 1_520,
    flemishWoonbonusRate: 0.40,
    flemishWoonbonusPre2015MinimumRate: 0.30,
    flemishWoonbonusExtraFirst10y: 760,
    flemishWoonbonusExtraChildren: 80,
    // Walloon chèque habitat: art. 145/46ter §2 as coordinated in FPS circular 2026/C/18
    // (1,520 and 125 not indexed); income limits 21,000 / 81,000 indexed per N25 ("Règle
    // spécifique art. 178, § 6bis": 26.394 / 101.805).
    walloonChequeHabitatBase: 1_520,
    walloonChequeHabitatChildSupplement: 125,
    walloonChequeHabitatIncomeThresholds: { lower: 26_394, upper: 101_805 },
    walloonChequeHabitatPhaseOutRate: 0.01275,
    basicPersonalExemption: 10_570,
    dependentChildExemptionIncreases: [0, 1_920, 4_950, 11_090, 17_940],
    extraChildExemptionFromFifth: 6_850,
    childUnder3Supplement: 720,
    otherDependentExemption: 1_920,
    disabledSupplement: 1_920,
    isolatedParentSupplement: 1_920,

    employeeSSRate: 0.1307,
    // Statutory civil servants: social security limited to health care ("beperkt tot de sector
    // ZIV-geneeskundige verzorging", RSZ instructions, limited insurance, public sector), i.e.
    // the 3.55% of law of 29 June 1981 art. 38 §2, 4°, plus the 7.5% survivors' pension
    // deduction of law of 15 May 1984 art. 60. 3.55% + 7.5% = 11.05% (derived: no page states
    // the sum).
    civilServantSSRate: 0.1105,
    // RSVZ 2024: RD no. 38 art. 12 §1 base amounts × the art. 14 §1 fraction 656.54 / 142.75
    // (RD of 17 Dec 2023, numac 2023206853). Rounding half-up to the cent is inferred (it
    // reproduces the published 2026 amounts exactly); no published 2024 table was reachable.
    selfEmployedContributions: {
        rate1: 0.205,
        rate2: 0.1416,
        threshold1: 72_810.95,
        threshold2: 107_300.30,
        minimumIncome: 16_861.46,
    },
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
    // Art. 51 al. 2, 3° (WIB 92, 2011 consolidation): helping spouses 5%; cap of al. 3 as fees.
    helpingSpouseProfessionalExpenseRate: 0.05,

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

    // Arts 147, 151/1, 152 (FPS indexation notice AY 2025, Fisconetplus 15618a3b): base
    // 1,148.93 → 2,151.72; additional 237.495 (raised by KB/WIB 92 art. 63^18/18) → 444.78;
    // art. 151/1 limits 19,030 / 27,900; art. 152 limits 27,900 / 55,810.
    pensionReduction: {
        base: 2_151.72,
        additional: 444.78,
        additionalLimits: { lower: 19_030, upper: 27_900 },
        // Art. 147 al. 1, 2°, b-c (FPS indexation notice AY 2025, Fisconetplus 15618a3b): base
        // 10,160 / 14,900 → 19,030 / 27,900. Al. 3 "Différence" 4,740 → 8,880 as published (notice
        // line "Différence: | 4.740,00 | 8.880,00"); the literal 27,900 − 19,030 is 8,870.
        statutoryPensionLimits: { lower: 19_030, upper: 27_900, difference: 8_880 },
        baseLimits: { lower: 27_900, upper: 55_810 },
    },

    maritalQuotientRate: 0.30,
    // Arts 87-88 cap: FPS indexation notice AY 2025 and fin.belgium.be previous-years page.
    maritalQuotientCap: 13_050,
    // Art. 126 §2 al. 1, 4°: FPS indexation notice AY 2025 (6,700 base → 13,050).
    treatyExemptSeparateThreshold: 13_050,
    // Art. 134 §3: 550 per child (FPS indexation notice AY 2025; fin.belgium.be Kinderen ten laste).
    refundableChildCreditCapPerChild: 550,

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
    // Base rates: Flanders 3.97% (Vlaamse Codex Fiscaliteit art. 2.1.4.0.1 §1, Justel
    // 2013036154); Wallonia and Brussels 1.25% (WIB 92 art. 255, Walloon and Brussels versions
    // on Fisconetplus 47b520a5-dca5-4454-a6ee-f47dfdd89ecf / 83ade4ce-e808-4a3b-8741-a6a4a464482a,
    // FPS consolidated texts only). The centimes are estimates, not sourced.
    regionPropertyTax: {
        flanders: { baseRate: 0.0397, centimes: 1100 },
        wallonia: { baseRate: 0.0125, centimes: 3300 },
        brussels: { baseRate: 0.0125, centimes: 4200 },
    },

    // See the `regionalAutonomyFactor` docstring: 0.75043 × 1.33257 (Flanders, Wallonia) and
    // 0.75043 × 1.32591 (Brussels).
    regionalAutonomyFactor: {
        flanders: 1.0,
        wallonia: 1.0,
        brussels: 0.995,
    },

    // WIB 92 art. 145/21, regional versions for income 2024 (Fisconetplus): Flanders 20% of
    // "uitgaven tot ten hoogste 1790 EUR" (bcb41a3c-bdb5-4b67-879a-72f538ffe4c8); Wallonia 30%
    // up to 1.790 EUR (360e95ff-2899-4037-9f23-7deaac95794d); Brussels 15% up to 1.790 EUR
    // (a747184a-d367-4a5f-8066-ffaa5f7f75df). `voucherPrice` is the legacy count conversion.
    serviceVoucherRegional: {
        flanders: { rate: 0.20, spendCap: 1_790, voucherPrice: 9 },
        wallonia: { rate: 0.30, spendCap: 1_790, voucherPrice: 9 },
        brussels: { rate: 0.15, spendCap: 1_790, voucherPrice: 10 },
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
    // Flemish woonbonus: frozen amounts, see IY 2024 (circular 2026/C/63 for AY 2026).
    flemishWoonbonusBaseCap: 2_280,
    flemishWoonbonus2015BaseCap: 1_520,
    flemishIntegratedWoonbonusBaseCap: 1_520,
    flemishWoonbonusRate: 0.40,
    flemishWoonbonusPre2015MinimumRate: 0.30,
    flemishWoonbonusExtraFirst10y: 760,
    flemishWoonbonusExtraChildren: 80,
    // Walloon chèque habitat: circular 2026/C/18; income limits per N26 (27.353 / 105.503).
    walloonChequeHabitatBase: 1_520,
    walloonChequeHabitatChildSupplement: 125,
    walloonChequeHabitatIncomeThresholds: { lower: 27_353, upper: 105_503 },
    walloonChequeHabitatPhaseOutRate: 0.01275,
    basicPersonalExemption: 10_910,
    dependentChildExemptionIncreases: [0, 1_980, 5_110, 11_440, 18_510],
    extraChildExemptionFromFifth: 7_070,
    childUnder3Supplement: 740,
    otherDependentExemption: 1_980,
    disabledSupplement: 1_980,
    isolatedParentSupplement: 1_980,

    employeeSSRate: 0.1307,
    // 3.55% + 7.5% = 11.05%; derivation and sources at IY 2024.
    civilServantSSRate: 0.1105,
    // RSVZ 2025: fraction 662.28 / 142.75 (RD of 29 Nov 2024, numac 2024205904); cent
    // rounding inferred as for 2024.
    selfEmployedContributions: {
        rate1: 0.205,
        rate2: 0.1416,
        threshold1: 73_447.52,
        threshold2: 108_238.40,
        minimumIncome: 17_008.88,
    },
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
    // Art. 51 al. 2, 3°: helping spouses 5% (rate fixed in the law, not indexed).
    helpingSpouseProfessionalExpenseRate: 0.05,

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

    // Arts 147, 151/1, 152 (FPS indexation notice AY 2026, Fisconetplus 934106e5): base
    // 1,148.93 → 2,219.27; additional 236.71 (raised by KB/WIB 92 art. 63^18/18) → 457.23;
    // art. 151/1 limits 19,630 / 28,780; art. 152 limits 28,780 / 57,560.
    pensionReduction: {
        base: 2_219.27,
        additional: 457.23,
        additionalLimits: { lower: 19_630, upper: 28_780 },
        // Art. 147 al. 1, 2°, b-c (FPS indexation notice AY 2026, Fisconetplus 934106e5): base
        // 10,160 / 14,900 → 19,630 / 28,780. Al. 3 "Différence" 4,740 → 9,160 as published (notice
        // line "Différence: | 4.740 | 9.160"); the literal 28,780 − 19,630 is 9,150.
        statutoryPensionLimits: { lower: 19_630, upper: 28_780, difference: 9_160 },
        baseLimits: { lower: 28_780, upper: 57_560 },
    },

    maritalQuotientRate: 0.30,
    // Arts 87-88 cap: FPS indexation notice AY 2026 and fin.belgium.be "Huwelijk en samenwonen".
    maritalQuotientCap: 13_460,
    // Art. 126 §2 al. 1, 4°: FPS indexation notice AY 2026 (6,700 base → 13,460).
    treatyExemptSeparateThreshold: 13_460,
    // Art. 134 §3: 550 per child, no longer indexed (law of 18 Dec 2025 art. 42).
    refundableChildCreditCapPerChild: 550,

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

    // Same primary rates as IY 2024 (see the `regionalAutonomyFactor` docstring). The earlier
    // 0.9951 / 0.9945 came from the PwC AY 2026 sample, whose 0.99501 matches Brussels.
    regionalAutonomyFactor: {
        flanders: 1.0,
        wallonia: 1.0,
        brussels: 0.995,
    },

    serviceVoucherRegional: {
        // Flanders: abolished "voor de belastbare tijdperken die aanvangen na 31.12.2024"
        // (FPS circular 2025/C/20, Fisconetplus b8383bc8-f4c0-4f71-85f8-cab07881d481).
        flanders: { rate: 0, spendCap: 0, voucherPrice: 10 },
        // Wallonia: 30% up to 1.850 EUR (art. 145/21 Walloon version, income 2025,
        // Fisconetplus 19a6ca22-88a1-4777-9961-de056536adc6).
        wallonia: { rate: 0.30, spendCap: 1_850, voucherPrice: 10 },
        // Brussels: 15% up to 1.850 EUR (art. 145/21 Brussels version, income 2025,
        // Fisconetplus 7c0161d3-42e2-4dcf-a0da-fcda6fea8979).
        brussels: { rate: 0.15, spendCap: 1_850, voucherPrice: 10 },
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
    // AY 2027). The v1 profile carries no birth years, so `computeBelgianPIT` always uses this
    // cap; the household engine uses `maritalQuotientCapBothSenior` when both spouses are 66+.
    maritalQuotientCap: 11_780,
    // Arts 87-88 when both spouses are 66+ on 1 Jan 2027: base 6,365 → 12,790 (N27; L2 arts 27
    // and 30, A). Applied by the household engine when both birth years are known.
    maritalQuotientCapBothSenior: 12_790,
    // Arts 147, 151/1, 151/2 after the law of 15 July 2026 (FPS indexation notice AY 2027,
    // Fisconetplus 042cb526; art. 147 income 2026 text 29f2d0bb): base 1,102.44 → 2,182.06;
    // additional 236.38 → 467.87 (no art. 147 al. 4 increase published for AY 2027 on
    // 2026-10-11); art. 151/1 limits 20,110 / 29,490; art. 151/2: one third from 58,980, tapering
    // from 60,260 to nothing above 72,310. Art. 152 no longer covers pensions.
    pensionReduction: {
        base: 2_182.06,
        additional: 467.87,
        additionalLimits: { lower: 20_110, upper: 29_490 },
        // Art. 147 al. 1, 2°, b-c (FPS indexation notice AY 2027, Fisconetplus 042cb526): base
        // 10,160 / 14,900 → 20,110 / 29,490. Al. 3 "Différence" 4,740 → 9,380 as published (notice
        // line "Différence: | 4.740 | 9.380"), equal to the literal 29,490 − 20,110.
        statutoryPensionLimits: { lower: 20_110, upper: 29_490, difference: 9_380 },
        baseLimits: { lower: 29_490, upper: 58_980 },
        baseZeroLimits: { from: 60_260, to: 72_310 },
    },
    // Art. 126 §2 al. 1, 4° a) after L2 art. 32: "meer dan het in artikel 131, eerste lid,
    // vermelde bedrag", i.e. the basic exemption (11,550 per N27).
    treatyExemptSeparateThreshold: 11_550,
    // Walloon chèque habitat income limits per N27 ("Règle spécifique art. 178, § 6bis":
    // 28.024 / 108.093). Loans signed from 1 Jan 2025 no longer qualify (circular 2026/C/18).
    walloonChequeHabitatIncomeThresholds: { lower: 28_024, upper: 108_093 },
    // RSVZ 2026: fraction 676.50 / 142.75 (RD of 25 Nov 2025, numac 2025203558); the amounts
    // match the RSVZ page "Hoeveel sociale bijdragen moet ik betalen?" and the 2026 folder.
    selfEmployedContributions: {
        rate1: 0.205,
        rate2: 0.1416,
        threshold1: 75_024.54,
        threshold2: 110_562.42,
        minimumIncome: 17_374.08,
    },
    // Wallonia: 30% "jusqu'à concurrence de 1.890 EUR" (art. 145/21 Walloon version, income
    // 2026, Fisconetplus bbda59c3-b9c5-4d4b-a838-0913695d355e). Brussels: abolished from AY 2027
    // by the ordinance of 18 Dec 2025 (BS 31.12.2025, numac 2025009750; FPS circular 2026/C/34,
    // Fisconetplus 0b274dac-47a2-45ba-a899-9cf884cedf03). Flanders: abolished since IY 2025.
    serviceVoucherRegional: {
        flanders: { rate: 0, spendCap: 0, voucherPrice: 10 },
        wallonia: { rate: 0.30, spendCap: 1_890, voucherPrice: 10 },
        brussels: { rate: 0, spendCap: 0, voucherPrice: 10 },
    },
    // Capital gains tax on financial assets: law of 6 April 2026 (numac 2026002780), circular
    // 2026/C/74. 10%; exemption 10,000 per taxpayer (art. 96/2, 2°, base 4,855, N27), so 20,000
    // for two spouses. The per-taxpayer carry-forward of art. 96/2, 3° and the 31 Dec 2025
    // step-up are documented in the BelgianTaxYearTable docstring and not modelled.
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
