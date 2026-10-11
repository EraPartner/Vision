export type {
    EmploymentType,
    BelgianRegion,
    ProfessionalExpenseMethod,
    PensionScheme,
    FilingStatus,
    MortgageCreditRegime,
    BelgianTaxProfile,
    BelgianTaxProfileSnapshots,
    FilingRecord,
    SnapshotAuditEntryKind,
    SnapshotAuditEntry,
    BelgianTaxProfileSnapshotMeta,
    BelgianTaxProfileSnapshotMetas,
    BracketTax,
    BelgianTaxCalculation,
} from "./types";
export type { BelgianTaxYearTable } from "./constants";
export {
    SUPPORTED_TAX_YEARS,
    LATEST_TAX_YEAR,
    EARLIEST_TAX_YEAR,
    DEFAULT_COMMUNAL_SURCHARGE,
    getTaxTable,
    isApproximatedTaxYear,
} from "./constants";
export { DEDUCTION_TYPE_PROFILE_FIELDS } from "./deductionCandidateFields";
export type { DeductionFieldMapping } from "./deductionCandidateFields";
export { computeBelgianPIT } from "./pit";
export { computePropertyTaxEstimate } from "./propertyTax";
export {
    computeEmployeeSocialSecurity,
    computeSpecialSocialSecurityContribution,
} from "./socialSecurity";
export type {
    PartnerId,
    ActivityKind,
    ForfaitCategory,
    IncomeActivity,
    PartnerReductionInputs,
    ProfessionalExpenseChoice,
    HouseholdPartner,
    RelationshipEventKind,
    RelationshipEvent,
    HouseholdRelationship,
    HouseholdDependents,
    HouseholdHomeInputs,
    MigrationNoteCode,
    UnmappedField,
    HouseholdMigrationRecord,
    BelgianTaxHouseholdV2,
    BelgianTaxHouseholdSnapshotsV2,
    AssessmentMode,
    AssessmentReason,
    AssessmentDecision,
    ActivityTaxResult,
    CategoryTaxResult,
    ExemptionAllocation,
    PartnerTaxResult,
    MaritalQuotientResult,
    HouseholdCsssResult,
    HouseholdTotals,
    HouseholdTaxIssueCode,
    HouseholdTaxIssueSeverity,
    HouseholdTaxIssue,
    HouseholdTaxResult,
} from "./householdTypes";
export {
    ACTIVITY_KINDS,
    FORFAIT_CATEGORIES,
    PARTNER_IDS,
    RELATIONSHIP_EVENT_KINDS,
} from "./householdTypes";
export { deriveAssessment } from "./assessment";
export { allocateExemptions, computeDependentSupplements } from "./exemptions";
export { computeMaritalQuotient, resolveMaritalQuotientCap } from "./maritalQuotient";
export {
    computeHouseholdTax,
    forfaitCategoryOf,
    toBelgianTaxCalculation,
} from "./household";
export {
    upgradeProfileV1ToHousehold,
    upgradeSnapshotsV1ToV2,
    projectHouseholdToProfileV1,
    applyProfileV1PatchToHousehold,
} from "./householdMigration";
export {
    belgianTaxHouseholdV2Schema,
    belgianTaxHouseholdSnapshotsV2Schema,
    parseHouseholdV2,
    parseHouseholdSnapshotsV2,
} from "./householdSchema";
export type { ParseResult } from "./householdSchema";
