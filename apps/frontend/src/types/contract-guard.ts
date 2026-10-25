/**
 * Compile-time drift guard between the hand-written, ergonomic API types in
 * ./api.ts (consumed by ~36 modules) and the contract types generated from
 * openapi.yaml into ./generated.ts (regenerated + drift-checked in CI).
 *
 * Why this file exists: generated.ts was being generated and CI-verified, yet
 * imported by zero modules — so the types the app actually consumes could drift
 * away from the OpenAPI contract unnoticed (they already had: api.ts's header
 * referenced a backend that no longer exists). The assertions below make
 * generated.ts load-bearing: `bun run typecheck` now fails if a field the code
 * relies on is renamed or removed in the contract, or if a money/quantity field
 * stops being numeric in the contract.
 *
 * Scope and intent:
 *  - One-directional and optionality-tolerant on purpose. It does NOT fail when
 *    the contract merely ADDS a field (a non-breaking change) or when
 *    required/optional/`| null` nuances differ between the two sources.
 *  - It only catches drift that would make the consumed types unsound.
 *  - Runtime value coercion (pg returns NUMERIC as strings) is a separate
 *    concern handled at the backend repository boundary; see
 *    packages/shared-utils/src/money.ts (`numericColumn` / `coerceNumericFields`).
 *
 * This module has no runtime output — it is pure type-level assertion.
 */
import type { components, operations } from "./generated";
import type {
    Transaction,
    TransactionCreate,
    Category,
    Account,
    Recipient,
    Tag,
    PlannedTransaction,
    Investment,
    PortfolioTransaction,
} from "./api";
import type {
    SplitItem,
    SplitPayment,
    OwedSummaryItem,
    OwedDetailItem,
} from "@/lib/api/splits";
import type { Attachment } from "@/lib/api/attachments";
import type { WatchlistItem } from "./watchlist";
import type {
    ChatMessage,
    ConversationSummary,
    ConversationDetail,
    OllamaModel,
    OllamaStatus,
    TokenUsage,
} from "./aiChat";
import type {
    ForecastForwardHolding,
    ForecastPoint,
    InstrumentProviderMapping,
    MacroSeriesItem,
    MacroSearchResponse,
    MacroSeriesResponse,
    MappingAuditQuote,
    MappingAuditResponse,
    MappingProposal,
    MappingProposalCandidate,
    MappingResolveResponse,
    MappingsResponse,
    PortfolioForecast,
    ProviderKeyStatus,
    ProviderKeysResponse,
    ResearchAnalyst,
    ResearchAnalystAction,
    ResearchAnalystConsensus,
    ResearchChartPoint,
    ResearchChartResponse,
    ResearchFundamentals,
    ResearchNewsArticle,
    ResearchNewsResponse,
    ResearchMeta,
    ResearchScorecard,
    ResearchScorecardResponse,
    ResearchSearchResponse,
    ResearchSearchItem,
    ScorecardFlag,
} from "./research";
import type { UpdateCheckStatus } from "@/lib/api/electron";
import type {
    CSV_NUMBER_FORMATS,
    CsvNumberFormat,
    ImportCsvResult,
} from "@/lib/api/imports";
import type {
    PortfolioBatchPolicy,
    PortfolioCustomConfig,
    PortfolioImportBatchPage,
    PortfolioReconciliationPlan,
    PortfolioReconciliationPolicy,
    PortfolioRowChoice,
} from "@/lib/api/portfolioImports";
import type { ReadParams, DbChange } from "@/lib/api/dbEditor";
import type { AssetClass } from "@vision/types/assetClasses";
import type { ImportBatch } from "./apiClient";

type Schemas = components["schemas"];

type Json200<Operation> = Operation extends {
    responses: { 200: { content: { "application/json": infer Response } } };
}
    ? Response
    : never;

type ResponseData<Operation> =
    NonNullable<Json200<Operation>> extends { data?: infer Data }
        ? NonNullable<Data>
        : never;

/** Compiles iff `T` is exactly `true`; any other type is a constraint error. */
type Expect<T extends true> = T;

/**
 * True iff every key of `A` also exists on `B` (A's keys ⊆ B's keys). `keyof A`
 * is a non-naked union here, so this is a single assignability check (no
 * distribution) — it tolerates optional/`| null` differences and only cares
 * about key presence.
 */
type KeysSubsetOf<A, B> = keyof A extends keyof B ? true : false;

/**
 * True iff `T`, with `null`/`undefined` stripped, is a finite union of string
 * literals (an OpenAPI `enum`), not plain `string`.
 */
type IsStringEnum<T> = [NonNullable<T>] extends [string]
    ? string extends NonNullable<T>
        ? false
        : true
    : false;

type EnumOf<T> =
    NonNullable<T> extends readonly (infer Item)[] ? NonNullable<Item> : NonNullable<T>;

/**
 * Keys where the contract (`B`) declares a string enum, or an array of one, and
 * the consumed type (`A`) accepts a value outside it — typically a plain
 * `string`. Narrower is fine: a consumed type may use a subset of the enum.
 */
type WidenedEnumKeys<A, B> = {
    [K in keyof A & keyof B]-?: IsStringEnum<EnumOf<B[K]>> extends true
        ? [EnumOf<A[K]>] extends [EnumOf<B[K]>]
            ? never
            : K
        : never;
}[keyof A & keyof B];

/**
 * `true` iff `A`'s keys ⊆ `B`'s keys and every string enum in `B` stays a
 * literal union in `A` (ADR-251). Otherwise it evaluates to the offending key
 * names, so `Expect<…>` fails with e.g. `Type '"status"' does not satisfy the
 * constraint 'true'`.
 */
type Matches<A, B> =
    KeysSubsetOf<A, B> extends false
        ? Exclude<keyof A, keyof B>
        : [WidenedEnumKeys<A, B>] extends [never]
          ? true
          : WidenedEnumKeys<A, B>;

type IsOptionalKey<T, K extends keyof T> =
    Record<never, never> extends Pick<T, K> ? true : false;

/** True iff `T`, with `null`/`undefined` stripped, is exactly `number`. */
type IsNumeric<T> = [NonNullable<T>] extends [number]
    ? [number] extends [NonNullable<T>]
        ? true
        : false
    : false;

// ── Key and enum coverage: every field the consumed type reads must exist in
//    the contract, and every contract enum must stay a literal union.
export type _KeysTransaction = Expect<
    Matches<Transaction, Schemas["Transaction"]>
>;
export type _KeysTransactionCreate = Expect<
    Matches<TransactionCreate, Schemas["TransactionCreate"]>
>;
export type _OptionalTransactionCreateAllowDuplicate = Expect<
    IsOptionalKey<Schemas["TransactionCreate"], "allow_duplicate">
>;
export type _KeysCategory = Expect<Matches<Category, Schemas["Category"]>>;
export type _KeysAccount = Expect<Matches<Account, Schemas["Account"]>>;
export type _KeysRecipient = Expect<
    Matches<Recipient, Schemas["Recipient"]>
>;
export type _KeysTag = Expect<Matches<Tag, Schemas["Tag"]>>;
export type _KeysPlannedTransaction = Expect<
    Matches<PlannedTransaction, Schemas["PlannedTransaction"]>
>;
export type _KeysInvestment = Expect<
    Matches<Investment, Schemas["Investment"]>
>;
export type _KeysPortfolioTransaction = Expect<
    Matches<PortfolioTransaction, Schemas["PortfolioTransaction"]>
>;

// ── Second wave: the schemas the spec had let rot unnoticed because nothing
//    here referenced them (splits, watchlist, attachments, AI chat). Each of
//    these described a payload the backend has never sent; guarding them is
//    what keeps the spec honest now that it has been corrected.
export type _KeysSplitItem = Expect<Matches<SplitItem, Schemas["Split"]>>;
export type _KeysSplitPayment = Expect<
    Matches<SplitPayment, Schemas["SplitPayment"]>
>;
export type _KeysOwedSummaryItem = Expect<
    Matches<OwedSummaryItem, Schemas["SplitOwed"]>
>;
export type _KeysWatchlistItem = Expect<
    Matches<WatchlistItem, Schemas["WatchlistItem"]>
>;
export type _KeysAttachment = Expect<
    Matches<Attachment, Schemas["Attachment"]>
>;
export type _KeysConversationSummary = Expect<
    Matches<ConversationSummary, Schemas["AiConversation"]>
>;
export type _KeysChatMessage = Expect<
    Matches<ChatMessage, Schemas["AiMessage"]>
>;
export type _KeysTokenUsage = Expect<
    Matches<TokenUsage, Schemas["AiTokenUsage"]>
>;
export type _KeysOllamaModel = Expect<
    Matches<OllamaModel, Schemas["OllamaModel"]>
>;

// ── Third wave: the payloads left as bare `Envelope`s after the 2026-07-27
//    schema rewrite (owed detail — the shape OwesPage divides money with —
//    conversation detail, Ollama status). Now that the spec names them, these
//    keep them honest.
export type _KeysOwedDetailItem = Expect<
    Matches<OwedDetailItem, Schemas["SplitOwedDetail"]>
>;
export type _KeysConversationDetail = Expect<
    Matches<ConversationDetail, Schemas["AiConversationDetail"]>
>;
export type _KeysOllamaStatus = Expect<
    Matches<OllamaStatus, Schemas["OllamaStatus"]>
>;

// ── Research endpoints: guard the actual operation response, not merely a
//    detached component. This closes the gap where every endpoint referenced
//    the untyped base Envelope while the UI maintained a second DTO universe.
export type _KeysResearchSearch = Expect<
    Matches<
        ResearchSearchResponse,
        ResponseData<operations["researchSearch"]>
    >
>;
export type _KeysResearchChart = Expect<
    Matches<
        ResearchChartResponse,
        ResponseData<operations["researchChart"]>
    >
>;
export type _KeysResearchFundamentals = Expect<
    Matches<
        ResearchFundamentals,
        Schemas["ResearchFundamentals"]
    >
>;
export type _KeysResearchAnalyst = Expect<
    Matches<ResearchAnalyst, ResponseData<operations["researchAnalyst"]>>
>;
export type _KeysResearchNews = Expect<
    Matches<ResearchNewsResponse, ResponseData<operations["researchNews"]>>
>;
export type _KeysResearchMacroSearch = Expect<
    Matches<
        MacroSearchResponse,
        ResponseData<operations["researchMacroSearch"]>
    >
>;
export type _KeysResearchMacroSeries = Expect<
    Matches<
        MacroSeriesResponse,
        ResponseData<operations["researchMacroSeries"]>
    >
>;
export type _KeysResearchScorecard = Expect<
    Matches<
        ResearchScorecardResponse,
        ResponseData<operations["researchScorecard"]>
    >
>;
export type _KeysResearchPortfolioForecast = Expect<
    Matches<
        PortfolioForecast,
        ResponseData<operations["researchPortfolioForecast"]>
    >
>;
export type _KeysResearchMappings = Expect<
    Matches<
        MappingsResponse,
        ResponseData<operations["researchListMappings"]>
    >
>;
export type _KeysResearchSavedMappings = Expect<
    Matches<
        MappingsResponse,
        ResponseData<operations["researchSaveMappings"]>
    >
>;
export type _KeysResearchMapping = Expect<
    Matches<
        InstrumentProviderMapping,
        Schemas["InstrumentProviderMapping"]
    >
>;
export type _KeysResearchMappingResolve = Expect<
    Matches<
        MappingResolveResponse,
        ResponseData<operations["researchResolveMappings"]>
    >
>;
export type _KeysResearchMappingAudit = Expect<
    Matches<
        MappingAuditResponse,
        ResponseData<operations["researchAuditMappings"]>
    >
>;
export type _KeysResearchProviderKeys = Expect<
    Matches<
        ProviderKeysResponse,
        ResponseData<operations["researchListProviderKeys"]>
    >
>;
export type _KeysResearchSetProviderKey = Expect<
    Matches<
        ProviderKeysResponse,
        ResponseData<operations["researchSetProviderKey"]>
    >
>;
export type _KeysResearchAnalystConsensus = Expect<
    Matches<ResearchAnalystConsensus, Schemas["ResearchAnalystConsensus"]>
>;
export type _KeysResearchAnalystAction = Expect<
    Matches<ResearchAnalystAction, Schemas["ResearchAnalystAction"]>
>;
export type _KeysResearchNewsArticle = Expect<
    Matches<ResearchNewsArticle, Schemas["ResearchNewsArticle"]>
>;
export type _KeysResearchMappingProposal = Expect<
    Matches<MappingProposal, Schemas["ResearchMappingProposal"]>
>;
export type _KeysResearchMappingCandidate = Expect<
    Matches<MappingProposalCandidate, Schemas["ResearchSearchItem"]>
>;
export type _KeysResearchAuditQuote = Expect<
    Matches<
        MappingAuditQuote,
        Schemas["ResearchMappingAuditData"]["quotes"][number]
    >
>;
export type _KeysResearchProviderKeyStatus = Expect<
    Matches<ProviderKeyStatus, Schemas["ResearchProviderKeyStatus"]>
>;
export type _KeysResearchScorecardBody = Expect<
    Matches<ResearchScorecard, Schemas["ResearchScorecard"]>
>;
export type _KeysResearchScorecardFlag = Expect<
    Matches<ScorecardFlag, Schemas["ResearchScorecardFlag"]>
>;
export type _KeysResearchForecastPoint = Expect<
    Matches<ForecastPoint, Schemas["ResearchForecastPoint"]>
>;
export type _KeysResearchForecastHolding = Expect<
    Matches<
        ForecastForwardHolding,
        Schemas["ResearchForecastForwardHolding"]
    >
>;
export type _KeysResearchMeta = Expect<
    Matches<ResearchMeta, Schemas["ResearchMeta"]>
>;
export type _KeysResearchSearchItem = Expect<
    Matches<ResearchSearchItem, Schemas["ResearchSearchItem"]>
>;
export type _KeysResearchChartPoint = Expect<
    Matches<ResearchChartPoint, Schemas["ResearchChartPoint"]>
>;
export type _KeysResearchMacroSeriesItem = Expect<
    Matches<MacroSeriesItem, Schemas["ResearchMacroSeriesItem"]>
>;
export type _KeysResearchForecastProjected = Expect<
    Matches<
        NonNullable<PortfolioForecast["projected"]>,
        Schemas["ResearchForecastProjected"]
    >
>;
export type _KeysResearchScorecardCounts = Expect<
    Matches<
        ResearchScorecard["counts"],
        Schemas["ResearchScorecard"]["counts"]
    >
>;
export type _KeysUpdateCheckStatus = Expect<
    Matches<
        UpdateCheckStatus,
        ResponseData<operations["adminUpdateCheck"]>
    >
>;

// ── Money/quantity fields must stay numeric in the contract (catches a
//    regression where the OpenAPI spec re-types an amount as a string).
export type _NumTransactionAmount = Expect<
    IsNumeric<Schemas["Transaction"]["amount"]>
>;
export type _NumTransactionBalance = Expect<
    IsNumeric<Schemas["Transaction"]["balance"]>
>;
export type _NumTransactionAmountEur = Expect<
    IsNumeric<Schemas["Transaction"]["amount_eur"]>
>;
export type _NumPlannedAmount = Expect<
    IsNumeric<Schemas["PlannedTransaction"]["amount"]>
>;
export type _NumPlannedLoanPrincipal = Expect<
    IsNumeric<Schemas["PlannedTransaction"]["loan_principal"]>
>;
export type _NumInvestmentCurrentPrice = Expect<
    IsNumeric<Schemas["Investment"]["current_price"]>
>;
export type _NumPortfolioAmount = Expect<
    IsNumeric<Schemas["PortfolioTransaction"]["amount"]>
>;
export type _NumPortfolioUnits = Expect<
    IsNumeric<Schemas["PortfolioTransaction"]["units"]>
>;
export type _NumPortfolioPricePerUnit = Expect<
    IsNumeric<Schemas["PortfolioTransaction"]["price_per_unit"]>
>;
export type _NumPortfolioFees = Expect<
    IsNumeric<Schemas["PortfolioTransaction"]["fees"]>
>;
export type _NumPortfolioTaxes = Expect<
    IsNumeric<Schemas["PortfolioTransaction"]["taxes"]>
>;
export type _NumSplitAmount = Expect<IsNumeric<Schemas["Split"]["amount"]>>;
export type _NumSplitAmountPaid = Expect<
    IsNumeric<Schemas["Split"]["amount_paid"]>
>;
export type _NumSplitPaymentAmount = Expect<
    IsNumeric<Schemas["SplitPayment"]["amount"]>
>;
export type _NumSplitOwedTotalOwed = Expect<
    IsNumeric<Schemas["SplitOwed"]["total_owed"]>
>;
export type _NumSplitOwedTotalPaid = Expect<
    IsNumeric<Schemas["SplitOwed"]["total_paid"]>
>;
export type _NumSplitOwedRemaining = Expect<
    IsNumeric<Schemas["SplitOwed"]["remaining"]>
>;
export type _NumWatchlistTargetPrice = Expect<
    IsNumeric<Schemas["WatchlistItem"]["target_price"]>
>;
export type _NumWatchlistAddedPrice = Expect<
    IsNumeric<Schemas["WatchlistItem"]["added_price"]>
>;
export type _NumAttachmentSizeBytes = Expect<
    IsNumeric<Schemas["Attachment"]["size_bytes"]>
>;
export type _NumOwedDetailTransactionAmount = Expect<
    IsNumeric<Schemas["SplitOwedDetail"]["transaction_amount"]>
>;
export type _NumOwedDetailRemaining = Expect<
    IsNumeric<Schemas["SplitOwedDetail"]["remaining"]>
>;

// ── Enum coverage for the domain clients in src/lib/api (ADR-251). Each block
//    pins a hand-written request or response type to its contract schema so a
//    contract enum cannot decay to `string` in the code that consumes it.

// ── Enums: dashboard, info, aggregations, portfolio, watchlist, market.

// ── Enums: transaction and portfolio imports, admin, database editor.

/** Drops the index signature `z.looseObject` adds, keeping the declared keys. */
type DeclaredKeys<T> = {
    [K in keyof T as string extends K ? never : K]: T[K];
};
export type _EnumsImportBatch = Expect<
    Matches<ImportBatch, Schemas["ImportBatch"]>
>;
export type _EnumsImportCsvResult = Expect<
    Matches<ImportCsvResult, Schemas["ImportCsvResult"]>
>;
export type _EnumsCsvNumberFormat = Expect<
    Matches<
        { number_format: CsvNumberFormat },
        { number_format: Schemas["CsvNumberFormat"] }
    >
>;
// The runtime list behind `isCsvNumberFormat` must name every contract value.
export type _EnumsCsvNumberFormatList = Expect<
    [Schemas["CsvNumberFormat"]] extends [(typeof CSV_NUMBER_FORMATS)[number]]
        ? true
        : false
>;
// Status only: the batch-list parser also reads `account_id`, which the
// contract's PortfolioImportBatch does not declare (key drift, reported).
export type _EnumsPortfolioImportBatch = Expect<
    Matches<
        Pick<PortfolioImportBatchPage["items"][number], "status">,
        Schemas["PortfolioImportBatch"]
    >
>;
// The upload form fields the parser config flattens into (camelCase in the
// config, snake_case on the wire). `default_type` is deliberately absent: the
// contract lists six values, the backend accepts all of PORTFOLIO_TXN_TYPES
// and the column mapper offers nine (see the report on the import enums).
export type _EnumsPortfolioImportUpload = Expect<
    Matches<
        {
            portfolio_format: PortfolioCustomConfig["format"];
            yield_basis_policy: PortfolioCustomConfig["yieldBasisPolicy"];
            default_asset_class: AssetClass;
        },
        Schemas["PortfolioImportUpload"]
    >
>;
export type _EnumsPortfolioParserConfig = Expect<
    Matches<
        { yieldBasisPolicy: PortfolioCustomConfig["yieldBasisPolicy"] },
        Schemas["PortfolioParserConfig"]["config"]
    >
>;
export type _EnumsPortfolioReconciliationRequest = Expect<
    Matches<
        { adopt_policy: PortfolioReconciliationPolicy },
        Schemas["PortfolioImportReconciliationRequest"]
    >
>;
export type _EnumsPortfolioReconciliationBatchPolicy = Expect<
    Matches<
        PortfolioBatchPolicy,
        Schemas["PortfolioImportReconciliationPlan"]["batchPolicies"][number]
    >
>;
export type _EnumsPortfolioReconciliationRowChoice = Expect<
    Matches<
        PortfolioRowChoice,
        Schemas["PortfolioImportReconciliationPlan"]["rowChoices"][number]
    >
>;
export type _EnumsPortfolioReconciliationPlan = Expect<
    Matches<
        DeclaredKeys<PortfolioReconciliationPlan>,
        Schemas["PortfolioImportReconciliationPlan"]
    >
>;
export type _EnumsDbEditorReadParams = Expect<
    Matches<
        ReadParams,
        NonNullable<operations["adminGetTableRows"]["parameters"]["query"]>
    >
>;
export type _EnumsDbEditorChange = Expect<
    Matches<
        DbChange,
        operations["adminMutateTableRows"]["requestBody"]["content"]["application/json"]["changes"][number]
    >
>;

// ── Enums: research, monitors, dossiers, analysis, AI.

// ── Enums: Belgian tax, reports, accounts, transactions, recipients, splits,
//    saved charts, settings.

import type { AccountCreate, AccountUpdate, BulkExportRequest, BulkTransactionFilter } from "./api";
import type {
    AccountCloseBalanceHandling,
    ReconcileMode,
    ReconcileResult,
} from "@/lib/api/accounts";
import type { BelgianTaxOverview } from "@/lib/api/belgianTax";
import type { RecipientPattern, RecipientPatternCreate, RecipientPatternUpdate } from "@/lib/api/recipients";
import type { ReportThemeTokens } from "@/lib/themeTokens";
import type { ReportPeriod, TaxReportHousehold, TaxReportProfile } from "@/lib/api/reports";
import type { BulkSplitRequest } from "@/lib/api/splits";
import type { getAccounts } from "@/lib/api/accounts";
import type { getTransactions } from "@/lib/api/transactions";
import type { getRecipients } from "@/lib/api/recipients";
import type {
    getAggregationRecipientPivot,
    getAggregationTagPivot,
} from "@/lib/api/aggregations";
import type { SavedChart, SavedChartCreate } from "./apiClient";
import type {
    BelgianTaxHouseholdV2,
    HouseholdCsssResult,
    HouseholdTaxIssue,
    HouseholdTaxResult,
    MaritalQuotientResult,
    PartnerTaxResult,
    ActivityTaxResult,
    CategoryTaxResult,
    AssessmentDecision,
    HouseholdPartner,
    IncomeActivity,
    RelationshipEvent,
    HouseholdRelationship,
    HouseholdDependents,
    HouseholdHomeInputs,
    HouseholdMigrationRecord,
} from "@/lib/belgianTax/householdTypes";

export type _EnumsAccountCreate = Expect<
    Matches<AccountCreate, Schemas["AccountCreate"]>
>;
export type _EnumsAccountUpdate = Expect<
    Matches<AccountUpdate, Schemas["AccountUpdate"]>
>;
export type _EnumsBulkTransactionFilter = Expect<
    Matches<BulkTransactionFilter, Schemas["BulkTransactionFilter"]>
>;
export type _EnumsBulkExport = Expect<
    Matches<
        Pick<BulkExportRequest, "format">,
        operations["bulkExportTransactions"]["requestBody"]["content"]["application/json"]
    >
>;
export type _EnumsCloseAccount = Expect<
    Matches<
        { balance_handling: AccountCloseBalanceHandling },
        operations["closeAccount"]["requestBody"]["content"]["application/json"]
    >
>;
export type _EnumsReconcileRequest = Expect<
    Matches<
        { mode: ReconcileMode },
        operations["reconcileAccount"]["requestBody"]["content"]["application/json"]
    >
>;
export type _EnumsReconcileResult = Expect<
    Matches<ReconcileResult, ResponseData<operations["reconcileAccount"]>>
>;
export type _EnumsSavedChart = Expect<
    Matches<SavedChart, Schemas["SavedChart"]>
>;
export type _EnumsSavedChartCreate = Expect<
    Matches<
        SavedChartCreate,
        operations["createSavedChart"]["requestBody"]["content"]["application/json"]
    >
>;
export type _EnumsSavedChartUpdate = Expect<
    Matches<
        Partial<SavedChartCreate>,
        operations["updateSavedChart"]["requestBody"]["content"]["application/json"]
    >
>;
export type _EnumsRecipientPattern = Expect<
    Matches<RecipientPattern, Schemas["RecipientPattern"]>
>;
export type _EnumsRecipientPatternCreate = Expect<
    Matches<
        RecipientPatternCreate,
        operations["createRecipientPattern"]["requestBody"]["content"]["application/json"]
    >
>;
export type _EnumsRecipientPatternUpdate = Expect<
    Matches<
        RecipientPatternUpdate,
        operations["updateRecipientPattern"]["requestBody"]["content"]["application/json"]
    >
>;
export type _EnumsBulkSplit = Expect<
    Matches<
        BulkSplitRequest,
        operations["createBulkSplits"]["requestBody"]["content"]["application/json"]
    >
>;
export type _EnumsReportPeriod = Expect<
    Matches<ReportPeriod, Schemas["ReportPeriod"]>
>;
export type _EnumsReportPrecomputedHousehold = Expect<
    Matches<TaxReportHousehold, Schemas["ReportPrecomputedHousehold"]>
>;
export type _EnumsReportPrecomputedQuotient = Expect<
    Matches<
        NonNullable<TaxReportHousehold["quotient"]>,
        NonNullable<Schemas["ReportPrecomputedHousehold"]["quotient"]>
    >
>;
export type _EnumsReportPrecomputedPartner = Expect<
    Matches<
        TaxReportHousehold["partners"][number],
        Schemas["ReportPrecomputedHousehold"]["partners"][number]
    >
>;
export type _EnumsBelgianTaxOverview = Expect<
    Matches<BelgianTaxOverview, Schemas["BelgianTaxOverview"]>
>;
export type _EnumsBelgianTaxSettingsWarning = Expect<
    Matches<
        BelgianTaxOverview["warnings"][number],
        Schemas["BelgianTaxSettingsWarning"]
    >
>;
export type _EnumsBelgianTaxHouseholdInput = Expect<
    Matches<BelgianTaxHouseholdV2, Schemas["BelgianTaxHouseholdInput"]>
>;
export type _EnumsBelgianTaxInputPartner = Expect<
    Matches<HouseholdPartner, Schemas["BelgianTaxInputPartner"]>
>;
export type _EnumsBelgianTaxInputActivity = Expect<
    Matches<IncomeActivity, Schemas["BelgianTaxInputPartnerActivity"]>
>;
export type _EnumsBelgianTaxInputRelationship = Expect<
    Matches<HouseholdRelationship, Schemas["BelgianTaxInputRelationship"]>
>;
export type _EnumsBelgianTaxInputRelationshipEvent = Expect<
    Matches<RelationshipEvent, Schemas["BelgianTaxInputRelationshipEvent"]>
>;
export type _EnumsBelgianTaxInputDependents = Expect<
    Matches<HouseholdDependents, Schemas["BelgianTaxInputDependents"]>
>;
export type _EnumsBelgianTaxInputHome = Expect<
    Matches<HouseholdHomeInputs, Schemas["BelgianTaxInputHome"]>
>;
export type _EnumsBelgianTaxInputMigratedFrom = Expect<
    Matches<HouseholdMigrationRecord, Schemas["BelgianTaxInputMigratedFrom"]>
>;
export type _EnumsBelgianTaxHouseholdResult = Expect<
    Matches<HouseholdTaxResult, Schemas["BelgianTaxHouseholdTaxResult"]>
>;
export type _EnumsBelgianTaxAssessment = Expect<
    Matches<AssessmentDecision, Schemas["BelgianTaxAssessmentDecision"]>
>;
export type _EnumsBelgianTaxPartnerResult = Expect<
    Matches<PartnerTaxResult, Schemas["BelgianTaxPartnerTaxResult"]>
>;
export type _EnumsBelgianTaxActivityResult = Expect<
    Matches<ActivityTaxResult, Schemas["BelgianTaxActivityTaxResult"]>
>;
export type _EnumsBelgianTaxCategoryResult = Expect<
    Matches<CategoryTaxResult, Schemas["BelgianTaxCategoryTaxResult"]>
>;
export type _EnumsBelgianTaxQuotient = Expect<
    Matches<MaritalQuotientResult, Schemas["BelgianTaxMaritalQuotientResult"]>
>;
export type _EnumsBelgianTaxCsss = Expect<
    Matches<HouseholdCsssResult, Schemas["BelgianTaxHouseholdCsssResult"]>
>;
export type _EnumsBelgianTaxIssue = Expect<
    Matches<HouseholdTaxIssue, Schemas["BelgianTaxHouseholdTaxIssue"]>
>;
export type _EnumsReportTheme = Expect<
    Matches<ReportThemeTokens, Schemas["ReportTheme"]>
>;
export type _EnumsReportTaxProfile = Expect<
    Matches<TaxReportProfile, Schemas["ReportTaxProfile"]>
>;
export type _EnumsAccountsQuery = Expect<
    Matches<
        NonNullable<Parameters<typeof getAccounts>[0]>,
        NonNullable<operations["getAccounts"]["parameters"]["query"]>
    >
>;
export type _EnumsTransactionsQuery = Expect<
    Matches<
        NonNullable<Parameters<typeof getTransactions>[0]>,
        NonNullable<operations["getTransactions"]["parameters"]["query"]>
    >
>;
export type _EnumsRecipientsQuery = Expect<
    Matches<
        NonNullable<Parameters<typeof getRecipients>[0]>,
        NonNullable<operations["getRecipients"]["parameters"]["query"]>
    >
>;
export type _EnumsRecipientPivotQuery = Expect<
    Matches<
        NonNullable<Parameters<typeof getAggregationRecipientPivot>[0]>,
        NonNullable<operations["getRecipientPivot"]["parameters"]["query"]>
    >
>;
export type _EnumsTagPivotQuery = Expect<
    Matches<
        NonNullable<Parameters<typeof getAggregationTagPivot>[0]>,
        NonNullable<operations["getTagPivot"]["parameters"]["query"]>
    >
>;
