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
