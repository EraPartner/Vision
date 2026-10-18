/**
 * Belgian tax — shared types.
 *
 * Source of truth: PwC Worldwide Tax Summaries (Belgium — Individual)
 * cross-checked with FOD Financiën / SPF Finances published indexed amounts.
 *
 * Income year = the year the income was earned. Assessment year = filing year (income year + 1).
 * All `taxYear` fields in this module refer to the **income year**.
 */

import type { BelgianTaxHouseholdV2, HouseholdTaxResult } from "./householdTypes.ts";

export type EmploymentType =
    | "employee"
    | "self_employed"
    | "director"
    | "civil_servant"
    | "retired"
    | "other";

/**
 * Kind of self-employed professional income (WIB 92 art. 23 §1 and art. 51).
 *  - `profits` ("winsten" / "bénéfices"): trading, craft and farming income. The lump-sum
 *    professional-expense forfait is the employee one (30%, same cap) per art. 51 al. 2, 1°
 *    and al. 3 ("rémunérations des travailleurs et bénéfices").
 *  - `fees` ("baten" / "profits" in French): liberal professions. The forfait is the
 *    degressive 28.7% / 10% / 5% / 3% scale of art. 51 al. 2, 4° with its own cap.
 * Source: FPS Finance indexation notice per assessment year, table I, art. 51.
 */
export type SelfEmployedIncomeKind = "profits" | "fees";

export type BelgianRegion = "flanders" | "wallonia" | "brussels";
export type ProfessionalExpenseMethod = "lump_sum" | "actual";
export type PensionScheme = "1050" | "1350";

/**
 * Filing status for income-splitting purposes.
 *  - `single`: single, divorced, widowed without surviving-spouse joint return, or legal cohabitant
 *    (cohabitants are taxed as singles by default unless they opt in).
 *  - `married_joint`: married or legal cohabitants opting for joint return. Triggers marital
 *    quotient modeling when one spouse has materially lower professional income than the other.
 */
export type FilingStatus = "single" | "married_joint";

/**
 * Regional own-home credit regime. Determined by the mortgage's region and origination year.
 *  - `flemish_woonbonus`: Flemish woonbonus (before 2015, 2015, and the 2016-2019
 *    "geïntegreerde woonbonus"), available for primary-residence mortgages signed before
 *    2020-01-01 in the Flemish Region.
 *  - `walloon_cheque_habitat`: Walloon "chèque habitat", available for primary-residence
 *    mortgages signed from 2016-01-01 to 2024-12-31 in the Walloon Region.
 *  - `none`: No annual credit modeled (Brussels post-2017 has only one-time stamp-duty rebate;
 *    pre-existing Brussels and post-2020 Flemish regimes are not modeled).
 */
export type MortgageCreditRegime =
    "flemish_woonbonus" | "walloon_cheque_habitat" | "none";

export interface BelgianTaxProfile {
    profileConfigured: boolean;
    employmentType: EmploymentType;
    /**
     * Only read when `employmentType === "self_employed"` and the lump-sum expense method is
     * used. Defaults to `profits` when omitted (see `SelfEmployedIncomeKind`).
     */
    selfEmployedIncomeKind?: SelfEmployedIncomeKind;
    grossAnnualIncome: number;
    professionalExpenseMethod: ProfessionalExpenseMethod;
    actualProfessionalExpenses: number;
    communalSurchargePercent: number;
    region: BelgianRegion;
    dependentChildren: number;
    /** Number of dependent children under 3 (extra exemption increase) */
    dependentChildrenUnder3?: number;
    /**
     * Number of dependent children with a recognised disability (CIR-92 art. 132 4°).
     * Per PwC: each handicapped child counts as TWO children on the dependent-children
     * scale. This count is the *subset* of `dependentChildren` who are disabled — it
     * adjusts the effective count used for the supplement lookup, not the head count.
     */
    dependentChildrenDisabled?: number;
    dependentOtherPersons: number;
    /**
     * Number of OTHER dependents (parents, grandparents, etc.) with a recognised
     * disability. Same "counts as two" rule applies (CIR-92 art. 136).
     */
    dependentOtherPersonsDisabled?: number;
    isDisabled: boolean;
    isSpouseDisabled: boolean;
    /** Single-parent flag — triggers the "isolated parent with dependents" supplement */
    isIsolatedParent?: boolean;
    cadastralIncome: number;
    /**
     * Optional override for the communal + provincial centimes additionnels applied to the
     * main residence. When omitted, the regional median from the year table is used.
     * Example: 1400 → +1400% centimes on top of the regional base rate.
     */
    cadastralCentimesOverride?: number;
    additionalResidences?: {
        label?: string;
        cadastralIncome: number;
        region?: BelgianRegion;
        isOwnHome?: boolean;
        /** Per-residence centimes override; same semantics as `cadastralCentimesOverride`. */
        centimesOverride?: number;
    }[];
    otherTaxableIncome: number;
    alimonyPaid: number;
    personalPensionContributions: number;
    pensionScheme?: PensionScheme;
    pensionEligible?: boolean;
    lifeInsurancePremiums: number;
    lifeInsuranceEligible?: boolean;
    /** Annual mortgage interest paid for primary residence (EUR). */
    mortgageInterestPaid: number;
    /** Annual capital repayment on the same mortgage (EUR). Used by Flemish woonbonus alongside interest. */
    mortgageCapitalRepaid?: number;
    /** Year the mortgage contract was signed. Determines applicable regime. */
    mortgageStartYear?: number | undefined;
    /**
     * Region where the mortgaged home lies.
     *
     * @deprecated Not used since 2026-10-11 (ADR-202). The own-home credit regime follows the
     * taxpayer's region (`region`, the fiscal domicile on 1 January of the assessment year),
     * because the special finance law of 16 January 1989 art. 5/1 §2 localises the personal
     * income tax at that domicile and art. 5/5 §4 gives the own-home reductions to the regions
     * without reference to the home's location. Stored values are kept and migrated unchanged.
     */
    mortgageRegion?: BelgianRegion | undefined;
    /** True if the financed property is the taxpayer's primary residence. */
    mortgageIsPrimaryResidence?: boolean;
    charitableDonations: number;
    charitableDonationsEligible?: boolean;
    childcareCosts: number;
    childcareEligibleDays?: number;
    childcareEligible?: boolean;
    employeeGroupInsuranceContributions?: number;
    employeeGroupInsuranceEligible?: boolean;
    unionDues: number;
    medicalExpenses: number;
    domesticHelpCosts?: number;
    domesticHelpEligible?: boolean;
    /**
     * Service vouchers (dienstencheques / titres-services) bought in the year. Kept for
     * compatibility: when `serviceVoucherSpend` is not set, the engine converts the count into an
     * expense amount with the year table's `voucherPrice`.
     */
    serviceVoucherCount?: number;
    /**
     * Amount paid for service vouchers in the year (EUR). Takes precedence over
     * `serviceVoucherCount`. The regional reduction (WIB 92 art. 145/21) is rate × min(spend, cap):
     *  - Flanders: 20% up to €1,790 (IY 2024); abolished from IY 2025.
     *  - Wallonia: 30% up to €1,790 / €1,850 / €1,890 (IY 2024 / 2025 / 2026).
     *  - Brussels: 15% up to €1,790 / €1,850 (IY 2024 / 2025); abolished from IY 2026.
     */
    serviceVoucherSpend?: number;
    serviceVoucherEligible?: boolean;
    /** Filing status — determines whether marital quotient modeling activates. */
    filingStatus?: FilingStatus;
    /**
     * Spouse's professional income (EUR). Only used when `filingStatus === 'married_joint'`.
     * Marital quotient transfers 30% of the higher-earner's professional income to the spouse
     * (capped per `maritalQuotientCap`) when the spouse's own professional income is below the cap.
     */
    spouseProfessionalIncome?: number;
    /** Total dividend income tracked for the year (used to model dividend WHT reclaim) */
    annualDividendIncome?: number;
    /** Savings deposit interest tracked (livret/spaarboekje) for the year */
    annualSavingsInterest?: number;
    /**
     * Category IDs the user has flagged as "salary-like" taxable income. Used by the
     * Tax Overview graphs to filter `monthlyData.income` (which is otherwise just every
     * positive-amount transaction) down to genuinely taxable inflows.
     */
    taxIncomeCategoryIds?: number[];
    taxYear: number;
}

/**
 * Map of income year → frozen `BelgianTaxProfile` snapshot for that year. Used by the
 * historical year viewer so past years can be rendered with the inputs the user actually
 * had at the time, while the engine still recomputes the calculation live.
 *
 * Snapshots are created automatically when the active profile's `taxYear` advances; the
 * outgoing year's profile is archived under its own year key before the new value is saved.
 * Users can also seed a snapshot retroactively for years that show up in the year list
 * solely because of transaction data.
 */
export type BelgianTaxProfileSnapshots = Record<number, BelgianTaxProfile>;

/**
 * Per-year filing record. Year is considered "filed" iff this is set. Filing also
 * freezes the calculation (engine drift protection): the calculation captured at file
 * time is preserved verbatim in `BelgianTaxProfileSnapshotMeta.frozenCalculation`.
 */
export interface FilingRecord {
    /** ISO timestamp the year was marked as filed. */
    filedAt: string;
    /** Free-text reference — Tax-on-Web confirmation number, paper return code, etc. */
    reference?: string;
}

/** Discriminator for `SnapshotAuditEntry`. */
export type SnapshotAuditEntryKind =
    "created" | "patched" | "filed" | "unfiled" | "frozen" | "unfrozen";

/**
 * Audit log entry capturing a single amendment to a year's snapshot or meta. Append-only.
 * Stored on `BelgianTaxProfileSnapshotMeta.history` and surfaced via the snapshot
 * history dialog.
 */
export interface SnapshotAuditEntry {
    /** ISO timestamp of the change. */
    at: string;
    kind: SnapshotAuditEntryKind;
    /**
     * Patch applied to the profile, populated only for `'created'` and `'patched'` entries.
     * Stored as the partial diff rather than full state so the log stays compact.
     */
    changes?: Partial<BelgianTaxProfile>;
    /**
     * Patch applied to the v2 household (ADR-200), for `'created'` and `'patched'` entries
     * written after the household upgrade. Same compact partial-diff convention as `changes`.
     */
    householdChanges?: Partial<BelgianTaxHouseholdV2>;
    /** Optional free-text reference — currently used for `'filed'` entries. */
    reference?: string;
}

/**
 * Sidecar metadata for a year's snapshot — filing status, frozen "as-filed" calculation,
 * and audit log. Stored under a separate setting (`belgian_tax_profile_snapshot_meta_v1`)
 * so the snapshot profile shape stays untouched and can be migrated independently.
 *
 * Meta is created lazily: the first call to freeze / file / append history for a year
 * inserts a meta entry. Years without meta are treated as un-filed, live-computed, and
 * with empty history (unchanged behavior pre-ADR-059).
 */
export interface BelgianTaxProfileSnapshotMeta {
    /**
     * Calculation captured verbatim at freeze / file time. When present, surfaces should
     * display this rather than the live-recomputed value so engine fixes don't
     * retroactively change "as-filed" numbers.
     */
    frozenCalculation?: BelgianTaxCalculation;
    /**
     * Household result (engine version 2, ADR-200) captured at freeze / file time, next to the
     * v1-shaped `frozenCalculation`.
     */
    frozenHouseholdResult?: HouseholdTaxResult;
    /** Filing record. Year is considered filed iff this is set. */
    filing?: FilingRecord;
    /** Append-only audit log of amendments to the snapshot or meta. */
    history?: SnapshotAuditEntry[];
}

/** Map of income year → `BelgianTaxProfileSnapshotMeta`. */
export type BelgianTaxProfileSnapshotMetas = Record<
    number,
    BelgianTaxProfileSnapshotMeta
>;

export interface BracketTax {
    b1: number;
    b2: number;
    b3: number;
    b4: number;
    total: number;
}

export interface BelgianTaxCalculation {
    /** The taxpayer's own gross income (salary + other taxable income). */
    grossIncome: number;
    /**
     * Spouse's professional income counted under a joint assessment (0 otherwise).
     * `totalPIT` and the special social security contribution cover both spouses, so
     * `householdGrossIncome`, `netTakeHome` and `effectiveRate` include it.
     */
    spouseProfessionalIncome: number;
    /** `grossIncome + spouseProfessionalIncome`; the base of `netTakeHome` and `effectiveRate`. */
    householdGrossIncome: number;
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
    /** Federal PIT before any reduction (exemption, credits). */
    federalPITBeforeExemption: number;
    personalExemptionBenefit: number;
    federalTaxCredits: number;
    /** Regime applied for own-home credit, if any. */
    ownHomeCreditRegime: MortgageCreditRegime;
    /** Estimated regional own-home tax credit (Flemish woonbonus / Walloon chèque habitat). */
    ownHomeCredit: number;
    /** Sum of reductions actually applied to PIT (clamped — never exceeds gross PIT). */
    taxReductions: number;
    /**
     * Reduction for pensions (WIB 92 arts 147-153), part of `federalTaxCredits`. Absent on
     * calculations frozen before 2026-10-11.
     */
    pensionReduction?: number;
    federalPITAfterReductions: number;
    communalSurcharge: number;
    /** Federal PIT after reductions + communal surcharge (income tax only). */
    totalPIT: number;
    /** Income tax + social security + special SS contribution + property tax estimate. */
    totalTaxBurden: number;
    effectiveRate: number;
    marginalRate: number;
    netTakeHome: number;
    monthlyTaxReserve: number;
    propertyTaxEstimate: number;
    /** Estimated dividend WHT reclaimable through the tax return (first €X of dividends). */
    dividendWhtReclaim: number;
    /** Estimated savings deposit interest non-recoverable tax (15% above exemption). */
    savingsInterestTax: number;
    /**
     * Income transferred to the non-earning / lower-earning spouse under the marital quotient.
     * 0 when filing status is single or when both spouses earn comparably.
     */
    maritalQuotientTransfer: number;
    /** Estimated tax reduction attributable to the marital quotient (informational). */
    maritalQuotientBenefit: number;
    /** Estimated service-voucher regional credit (after marital quotient). */
    serviceVoucherCredit: number;
    breakdown: {
        /**
         * English calculation-side label. Not a display string: the on-screen
         * PIT table renders its own translated rows (`tax.pit.row.*`). Consumers
         * that do surface a row translate it themselves.
         */
        label: string;
        amount: number;
        rate?: number;
        bracket?: string;
        /**
         * 1-based bracket ordinal, present only on progressive-bracket rows.
         * Carried explicitly because empty brackets are omitted from the array,
         * so position does not imply the bracket number. Maps to the
         * `tax.pit.row.bracket{n}` translation keys.
         */
        bracketNumber?: number;
    }[];
}
