export type {
    BelgianRegion,
    ProfessionalExpenseMethod,
    BelgianTaxProfile,
    BelgianTaxProfileSnapshots,
    SnapshotAuditEntryKind,
    SnapshotAuditEntry,
    BelgianTaxProfileSnapshotMeta,
    BelgianTaxProfileSnapshotMetas,
    BelgianTaxCalculation,
} from "./types";
export type { BelgianTaxYearTable } from "@vision/shared-utils/belgian-tax/constants";
export {
    LATEST_TAX_YEAR,
    DEFAULT_COMMUNAL_SURCHARGE,
} from "@vision/shared-utils/belgian-tax/taxYears";
export { DEDUCTION_TYPE_PROFILE_FIELDS } from "./deductionCandidateFields";
export type {
    BelgianTaxHouseholdV2,
    BelgianTaxHouseholdSnapshotsV2,
    HouseholdTaxIssue,
    HouseholdTaxResult,
} from "./householdTypes";
// The tax engine runs on the server (ADR-217) and is not part of this library. The household
// shape helpers (`householdMigration.ts`, `householdSchema.ts`) are imported by path: the
// provider loads them lazily through `householdRuntime.ts`, outside the boot bundle (see
// scripts/check-bundle-size.ts).
