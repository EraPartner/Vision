/**
 * Belgian tax — household model (version 2).
 *
 * A household holds one or two partners. Each partner carries a list of income activities
 * (employment, self-employment, pension, …), their own deductions and tax reductions. The
 * assessment mode (single / separate / joint, WIB 92 art. 126) is derived from dated relationship
 * events for the income year instead of a user-chosen filing status. See ADR-200 and
 * docs/reference/belgian-tax-rule-matrix.md.
 *
 * Income year semantics are the same as in `types.ts`: `taxYear` is the income year.
 */

import type {
    BelgianRegion,
    BelgianTaxProfile,
    BracketTax,
    MortgageCreditRegime,
    ProfessionalExpenseMethod,
} from "./types";
import type { ForfaitCategory, ReductionInputs, TaxReductionBreakdown } from "./personPit";

export type { ForfaitCategory } from "./personPit";

/** Stable partner identifier. Partner A is always present; B is the spouse or partner. */
export type PartnerId = "A" | "B";

export const PARTNER_IDS: readonly PartnerId[] = ["A", "B"];

/**
 * Kind of professional activity (WIB 92 art. 23 §1 categories, plus two technical kinds).
 *  - `employee` / `civil_servant`: remuneration of employees (art. 30, 1°), 13.07% / 11.05%
 *    personal social security, forfait category `remuneration`.
 *  - `director`: company director remuneration (art. 30, 2°), forfait `director`.
 *  - `self_employed_profits`: trading profits (winsten, art. 24), forfait `profits`.
 *  - `self_employed_fees`: liberal-profession fees (baten, art. 27), forfait `fees`.
 *  - `helping_spouse`: helping-spouse remuneration (art. 30, 3°), forfait `helping_spouse`.
 *  - `pension`: pensions and replacement income (art. 34), no forfait, no CSSS base.
 *  - `other_professional`: other professional income without forfait.
 *  - `net_professional_amount`: an already-net professional income figure (the legacy
 *    `spouseProfessionalIncome`); no social security, no forfait.
 */
export type ActivityKind =
    | "employee"
    | "civil_servant"
    | "director"
    | "self_employed_profits"
    | "self_employed_fees"
    | "helping_spouse"
    | "pension"
    | "other_professional"
    | "net_professional_amount";

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
    "employee",
    "civil_servant",
    "director",
    "self_employed_profits",
    "self_employed_fees",
    "helping_spouse",
    "pension",
    "other_professional",
    "net_professional_amount",
];

export const FORFAIT_CATEGORIES: readonly ForfaitCategory[] = [
    "remuneration",
    "profits",
    "director",
    "fees",
    "helping_spouse",
    "none",
];

/** Self-employed occupation level (RSVZ: main or secondary occupation). Stored, not used yet. */
export type SelfEmployedOccupation = "main" | "secondary";

export interface IncomeActivity {
    /** Unique within the household, pattern `act_<id>` (e.g. `act_A_1`). */
    id: string;
    kind: ActivityKind;
    label?: string;
    /** Gross annual income of the activity (EUR). Ignored for `net_professional_amount`. */
    grossIncome: number;
    /** Net professional income; only for `net_professional_amount`. */
    netProfessionalIncome?: number;
    /** ISO date (YYYY-MM-DD) the activity started in the income year, informational. */
    startDate?: string;
    /** ISO date (YYYY-MM-DD) the activity ended in the income year, informational. */
    endDate?: string;
    selfEmployedOccupation?: SelfEmployedOccupation;
    /**
     * Personal social contributions paid for a self-employed activity (art. 52, 7°). Deducted
     * from the gross before the forfait for profits, fees and helping spouses.
     */
    socialContributionsPaid?: number;
    /** Professional withholding tax (bedrijfsvoorheffing) withheld; stored, not used yet. */
    withholdingTax?: number;
    /** Advance tax payments (voorafbetalingen); stored, not used yet. */
    prepayments?: number;
    /** Opaque references to the evidence (transaction ids, document names). */
    sourceRefs?: string[];
}

/** Per-partner tax-reduction inputs; same field names as on `BelgianTaxProfile`. */
export type PartnerReductionInputs = ReductionInputs;

export interface ProfessionalExpenseChoice {
    method: ProfessionalExpenseMethod;
    /** Actual expenses claimed for the category; read only when `method === "actual"`. */
    actualAmount: number;
}

export interface HouseholdPartner {
    id: PartnerId;
    displayName?: string;
    /** Calendar year of birth. Needed for the IY 2026 marital-quotient cap for two 66+ spouses. */
    birthYear?: number;
    isDisabled: boolean;
    /** Isolated-parent supplement (art. 133 al. 1, 1°) requested. */
    isIsolatedParent?: boolean;
    activities: IncomeActivity[];
    /** Expense method per forfait category; a missing category uses the lump-sum forfait. */
    professionalExpenses: Partial<Record<ForfaitCategory, ProfessionalExpenseChoice>>;
    /** Union dues paid; deducted only inside an actual-expense claim for remuneration. */
    unionDues: number;
    /** Non-professional taxable income in this partner's name (rental, …). */
    otherTaxableIncome: number;
    /** Alimony paid by this partner (art. 104, 1°-2°). */
    alimonyPaid: number;
    /** Professional income exempt by treaty without progression (art. 126 §2 al. 1, 4°). */
    treatyExemptProfessionalIncome?: number;
    reductions: PartnerReductionInputs;
    annualDividendIncome?: number;
    annualSavingsInterest?: number;
}

export type RelationshipEventKind =
    | "marriage"
    | "legal_cohabitation"
    | "legal_cohabitation_ended"
    | "factual_cohabitation_start"
    | "factual_separation"
    | "divorce"
    | "death";

export const RELATIONSHIP_EVENT_KINDS: readonly RelationshipEventKind[] = [
    "marriage",
    "legal_cohabitation",
    "legal_cohabitation_ended",
    "factual_cohabitation_start",
    "factual_separation",
    "divorce",
    "death",
];

export interface RelationshipEvent {
    id: string;
    kind: RelationshipEventKind;
    /** ISO date, YYYY-MM-DD. */
    date: string;
    /** The partner concerned. Required for `death` (the deceased partner). */
    partnerId?: PartnerId;
}

export interface HouseholdRelationship {
    events: RelationshipEvent[];
    /**
     * Choice of the surviving spouse for the year of death (art. 126 §3). Without a choice the
     * year of death is assessed separately (art. 126 §2 al. 1, 3°).
     */
    deathYearElection?: "joint" | "separate";
    /**
     * Set by the migration from a `married_joint` v1 profile: assume a joint assessment while no
     * relationship event is recorded (raises `relationship_dates_missing`).
     */
    legacyAssumedJoint?: boolean;
}

export interface HouseholdDependents {
    children: number;
    childrenUnder3?: number;
    /** Subset of `children` with a recognised disability (counts twice). */
    childrenDisabled?: number;
    otherPersons: number;
    /** Subset of `otherPersons` with a recognised disability (counts twice). */
    otherPersonsDisabled?: number;
    /** Partner who claims the dependants outside a joint assessment; defaults to A. */
    claimantPartnerId?: PartnerId;
}

export type HouseholdHomeInputs = Pick<
    BelgianTaxProfile,
    | "cadastralIncome"
    | "cadastralCentimesOverride"
    | "additionalResidences"
    | "mortgageInterestPaid"
    | "mortgageCapitalRepaid"
    | "mortgageStartYear"
    | "mortgageRegion"
    | "mortgageIsPrimaryResidence"
> & {
    /** Partner who claims the own-home credit; defaults to A. */
    mortgageCreditPartnerId?: PartnerId;
    /**
     * Walloon chèque habitat: income year of the first taxable period in which the credit was
     * claimed (art. 145/46quinquies). The twenty-period window and the halving from the eleventh
     * period count from it; when absent, the loan year (`mortgageStartYear`) is the proxy. No v1
     * source: the upgrade leaves it undefined.
     */
    firstQualifyingYear?: number;
    /**
     * Flemish woonbonus +80: dependent children of the borrower on 1 January of the year after
     * the loan year, a disabled child counted twice (arts 145/37 §2 al. 3, 145/38/2 §2 al. 3).
     * When absent, this year's dependent children of the claimant stand in and the engine raises
     * `woonbonus_children_at_loan_start_missing`. No v1 source: the upgrade leaves it undefined.
     */
    woonbonusChildrenAtLoanStart?: number;
};

/** Why a v1 field could not be mapped onto the household. */
export type MigrationNoteCode =
    | "spouse_income_without_joint_filing"
    | "spouse_disability_without_joint_filing"
    | "unknown_profile_field";

export interface UnmappedField {
    field: string;
    note: MigrationNoteCode;
    value?: unknown;
}

export interface HouseholdMigrationRecord {
    fromVersion: 1;
    unmappedFields: UnmappedField[];
}

export interface BelgianTaxHouseholdV2 {
    version: 2;
    taxYear: number;
    profileConfigured: boolean;
    region: BelgianRegion;
    communalSurchargePercent: number;
    /** One or two partners; partner A is always present. */
    partners: HouseholdPartner[];
    relationship: HouseholdRelationship;
    dependents: HouseholdDependents;
    home: HouseholdHomeInputs;
    taxIncomeCategoryIds?: number[];
    migratedFrom?: HouseholdMigrationRecord;
}

/** Map of income year → household snapshot (same role as `BelgianTaxProfileSnapshots`). */
export type BelgianTaxHouseholdSnapshotsV2 = Record<number, BelgianTaxHouseholdV2>;

// ── Results ──────────────────────────────────────────────────────────────────

export type AssessmentMode = "single" | "separate" | "joint";

export type AssessmentReason =
    | "one_partner"
    | "no_legal_union"
    | "union_year"
    | "union_year_after_legal_cohabitation"
    | "union_in_force"
    | "factual_separation_year"
    | "factually_separated"
    | "dissolution_year"
    | "dissolved"
    | "death_year"
    | "death_year_joint_election"
    | "surviving_partner"
    | "treaty_exempt_income"
    | "legacy_assumed_joint";

export interface AssessmentDecision {
    mode: AssessmentMode;
    reason: AssessmentReason;
    /** Article the decision rests on, e.g. "WIB 92 art. 126 §2 al. 1, 1°". */
    legalBasis: string;
    /** True when the taxpayer may elect the other mode (year of death, art. 126 §3). */
    electable?: boolean;
    /** Partners assessed for the year (the survivor only after a death in an earlier year). */
    partnerIds: PartnerId[];
}

export interface ActivityTaxResult {
    activityId: string;
    kind: ActivityKind;
    forfaitCategory: ForfaitCategory;
    grossIncome: number;
    employeeSocialSecurity: number;
    /** Self-employed social contributions deducted before the forfait (art. 52, 7°). */
    socialContributionsPaid: number;
    /** Category expenses allocated pro rata to this activity. */
    professionalExpenses: number;
    netProfessionalIncome: number;
}

export interface CategoryTaxResult {
    category: ForfaitCategory;
    method: ProfessionalExpenseMethod;
    grossAfterContributions: number;
    professionalExpenses: number;
    unionDuesApplied: number;
    /** Category net income, clamped at 0 (no loss offset). */
    netIncome: number;
}

export interface ExemptionAllocation {
    basic: number;
    disability: number;
    dependentSupplements: number;
    isolatedParentSupplement: number;
    /** basic + disability + dependentSupplements + isolatedParentSupplement. */
    ownTotal: number;
    /** Unused exemption received from the other spouse (joint assessment). */
    transferredIn: number;
    /** Unused exemption passed to the other spouse (joint assessment). */
    transferredOut: number;
    /** ownTotal + transferredIn − transferredOut. */
    total: number;
    /** Part of `total` charged on the taxable income: min(total, taxable income). */
    applied: number;
}

export interface PartnerTaxResult {
    partnerId: PartnerId;
    activities: ActivityTaxResult[];
    categories: CategoryTaxResult[];
    /** Gross income of the activities that carry a gross figure (not `net_professional_amount`). */
    grossIncome: number;
    employeeSocialSecurity: number;
    professionalExpenses: number;
    unionDuesApplied: number;
    netProfessionalIncome: number;
    otherTaxableIncome: number;
    alimonyDeduction: number;
    /** Net professional + other income − alimony, before the marital quotient. */
    taxableIncomeBeforeQuotient: number;
    /** Positive when the quotient adds income to this partner, negative when it removes some. */
    quotientAdjustment: number;
    taxableIncome: number;
    bracketTax: BracketTax;
    exemption: ExemptionAllocation;
    exemptionBenefit: number;
    pitAfterExemption: number;
    reductions: TaxReductionBreakdown;
    ownHomeCreditRegime: MortgageCreditRegime;
    ownHomeCredit: number;
    /** Reduction for pensions of this partner (WIB 92 arts 147-153, per spouse by art. 150). */
    pensionReduction: number;
    /**
     * Reductions charged on this partner's tax: min(pension reduction + reductions + own-home
     * credit, tax).
     */
    reductionsApplied: number;
    federalPITAfterReductions: number;
    communalSurcharge: number;
    totalPIT: number;
    specialSocialSecurityContribution: number;
    csssSubject: boolean;
    dividendWhtReclaim: number;
    savingsInterestTax: number;
    marginalRate: number;
}

export interface MaritalQuotientResult {
    applied: boolean;
    transfer: number;
    fromPartnerId?: PartnerId;
    toPartnerId?: PartnerId;
    /** min(30% of the household professional income, cap). */
    target: number;
    cap: number;
    /** Combined tax saving (0 when not applied). */
    benefit: number;
}

export interface HouseholdCsssResult {
    scale: "single" | "joint" | "none";
    /** Household base under joint assessment, otherwise the sum of each subject partner's base. */
    base: number;
    total: number;
}

export interface HouseholdTotals {
    /** Cash income: gross activity income, other taxable income and already-net amounts. */
    grossIncome: number;
    employeeSocialSecurity: number;
    professionalExpenses: number;
    netProfessionalIncome: number;
    taxableIncome: number;
    federalPITBeforeExemption: number;
    personalExemptionBenefit: number;
    taxReductions: number;
    federalPITAfterReductions: number;
    communalSurcharge: number;
    totalPIT: number;
    specialSocialSecurityContribution: number;
    propertyTaxEstimate: number;
    totalTaxBurden: number;
    netTakeHome: number;
    dividendWhtReclaim: number;
    savingsInterestTax: number;
    /** Refundable child tax credit (art. 134 §3); always 0 until the formula is sourced. */
    refundableChildCredit: number;
}

export type HouseholdTaxIssueCode =
    | "relationship_dates_missing"
    | "treaty_exempt_separate_assessment"
    | "deceased_partner_not_assessed"
    | "director_contributions_not_deducted"
    | "forfait_category_aggregation_unverified"
    | "union_dues_outside_remuneration_claim"
    | "loss_offset_not_modelled"
    | "joint_reduction_allocation_unverified"
    | "csss_mixed_activity_base_unverified"
    | "refundable_child_credit_not_modelled"
    | "isolated_parent_supplement_not_granted"
    | "senior_quotient_cap_birth_years_missing"
    | "woonbonus_children_at_loan_start_missing"
    | "pension_reduction_activity_income_not_excluded"
    | "pension_reduction_quotient_unverified"
    | "donation_joint_ceiling_unverified"
    | "mortgage_region_not_used";

export type HouseholdTaxIssueSeverity = "info" | "warning" | "needs_source";

export interface HouseholdTaxIssue {
    code: HouseholdTaxIssueCode;
    severity: HouseholdTaxIssueSeverity;
    partnerId?: PartnerId;
    activityId?: string;
}

export interface HouseholdTaxResult {
    engineVersion: 2;
    incomeYear: number;
    assessment: AssessmentDecision;
    partners: PartnerTaxResult[];
    quotient: MaritalQuotientResult;
    csss: HouseholdCsssResult;
    propertyTaxEstimate: number;
    totals: HouseholdTotals;
    issues: HouseholdTaxIssue[];
}
