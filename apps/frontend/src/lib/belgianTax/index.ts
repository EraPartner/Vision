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
export type { BelgianTaxYearTable } from "@vision/shared-utils/belgian-tax/constants";
export {
    SUPPORTED_TAX_YEARS,
    LATEST_TAX_YEAR,
    EARLIEST_TAX_YEAR,
    DEFAULT_COMMUNAL_SURCHARGE,
} from "@vision/shared-utils/belgian-tax/taxYears";
export { DEDUCTION_TYPE_PROFILE_FIELDS } from "./deductionCandidateFields";
export type { DeductionFieldMapping } from "./deductionCandidateFields";
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
export { forfaitCategoryOf } from "./forfaitCategory";
// The tax engine runs on the server (ADR-217) and is not part of this library. The household
// shape helpers (`householdMigration.ts`, `householdSchema.ts`) are imported by path: the
// provider loads them lazily through `householdRuntime.ts`, outside the boot bundle (see
// scripts/check-bundle-size.ts).
