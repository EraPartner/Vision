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
 *    packages/shared-utils/src/money.js (`numericColumn` / `coerceNumericFields`).
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
    ResearchQuote,
    ResearchMeta,
    ResearchScorecard,
    ResearchScorecardResponse,
    ResearchSearchResponse,
    ResearchSearchItem,
    ScorecardFlag,
} from "./research";
import type { UpdateCheckStatus } from "@/lib/api/electron";

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

type IsOptionalKey<T, K extends keyof T> =
    Record<never, never> extends Pick<T, K> ? true : false;

/** True iff `T`, with `null`/`undefined` stripped, is exactly `number`. */
type IsNumeric<T> = [NonNullable<T>] extends [number]
    ? [number] extends [NonNullable<T>]
        ? true
        : false
    : false;

// ── Key coverage: every field the consumed type reads must exist in the contract.
export type _KeysTransaction = Expect<
    KeysSubsetOf<Transaction, Schemas["Transaction"]>
>;
export type _KeysTransactionCreate = Expect<
    KeysSubsetOf<TransactionCreate, Schemas["TransactionCreate"]>
>;
export type _OptionalTransactionCreateAllowDuplicate = Expect<
    IsOptionalKey<Schemas["TransactionCreate"], "allow_duplicate">
>;
export type _KeysCategory = Expect<KeysSubsetOf<Category, Schemas["Category"]>>;
export type _KeysAccount = Expect<KeysSubsetOf<Account, Schemas["Account"]>>;
export type _KeysRecipient = Expect<
    KeysSubsetOf<Recipient, Schemas["Recipient"]>
>;
export type _KeysTag = Expect<KeysSubsetOf<Tag, Schemas["Tag"]>>;
export type _KeysPlannedTransaction = Expect<
    KeysSubsetOf<PlannedTransaction, Schemas["PlannedTransaction"]>
>;
export type _KeysInvestment = Expect<
    KeysSubsetOf<Investment, Schemas["Investment"]>
>;
export type _KeysPortfolioTransaction = Expect<
    KeysSubsetOf<PortfolioTransaction, Schemas["PortfolioTransaction"]>
>;

// ── Second wave: the schemas the spec had let rot unnoticed because nothing
//    here referenced them (splits, watchlist, attachments, AI chat). Each of
//    these described a payload the backend has never sent; guarding them is
//    what keeps the spec honest now that it has been corrected.
export type _KeysSplitItem = Expect<KeysSubsetOf<SplitItem, Schemas["Split"]>>;
export type _KeysSplitPayment = Expect<
    KeysSubsetOf<SplitPayment, Schemas["SplitPayment"]>
>;
export type _KeysOwedSummaryItem = Expect<
    KeysSubsetOf<OwedSummaryItem, Schemas["SplitOwed"]>
>;
export type _KeysWatchlistItem = Expect<
    KeysSubsetOf<WatchlistItem, Schemas["WatchlistItem"]>
>;
export type _KeysAttachment = Expect<
    KeysSubsetOf<Attachment, Schemas["Attachment"]>
>;
export type _KeysConversationSummary = Expect<
    KeysSubsetOf<ConversationSummary, Schemas["AiConversation"]>
>;
export type _KeysChatMessage = Expect<
    KeysSubsetOf<ChatMessage, Schemas["AiMessage"]>
>;
export type _KeysTokenUsage = Expect<
    KeysSubsetOf<TokenUsage, Schemas["AiTokenUsage"]>
>;
export type _KeysOllamaModel = Expect<
    KeysSubsetOf<OllamaModel, Schemas["OllamaModel"]>
>;

// ── Third wave: the payloads left as bare `Envelope`s after the 2026-07-27
//    schema rewrite (owed detail — the shape OwesPage divides money with —
//    conversation detail, Ollama status). Now that the spec names them, these
//    keep them honest.
export type _KeysOwedDetailItem = Expect<
    KeysSubsetOf<OwedDetailItem, Schemas["SplitOwedDetail"]>
>;
export type _KeysConversationDetail = Expect<
    KeysSubsetOf<ConversationDetail, Schemas["AiConversationDetail"]>
>;
export type _KeysOllamaStatus = Expect<
    KeysSubsetOf<OllamaStatus, Schemas["OllamaStatus"]>
>;

// ── Research endpoints: guard the actual operation response, not merely a
//    detached component. This closes the gap where every endpoint referenced
//    the untyped base Envelope while the UI maintained a second DTO universe.
export type _KeysResearchSearch = Expect<
    KeysSubsetOf<
        ResearchSearchResponse,
        ResponseData<operations["researchSearch"]>
    >
>;
export type _KeysResearchQuote = Expect<
    KeysSubsetOf<ResearchQuote, ResponseData<operations["researchQuote"]>>
>;
export type _KeysResearchChart = Expect<
    KeysSubsetOf<
        ResearchChartResponse,
        ResponseData<operations["researchChart"]>
    >
>;
export type _KeysResearchFundamentals = Expect<
    KeysSubsetOf<
        ResearchFundamentals,
        ResponseData<operations["researchFundamentals"]>
    >
>;
export type _KeysResearchAnalyst = Expect<
    KeysSubsetOf<ResearchAnalyst, ResponseData<operations["researchAnalyst"]>>
>;
export type _KeysResearchNews = Expect<
    KeysSubsetOf<ResearchNewsResponse, ResponseData<operations["researchNews"]>>
>;
export type _KeysResearchMacroSearch = Expect<
    KeysSubsetOf<
        MacroSearchResponse,
        ResponseData<operations["researchMacroSearch"]>
    >
>;
export type _KeysResearchMacroSeries = Expect<
    KeysSubsetOf<
        MacroSeriesResponse,
        ResponseData<operations["researchMacroSeries"]>
    >
>;
export type _KeysResearchScorecard = Expect<
    KeysSubsetOf<
        ResearchScorecardResponse,
        ResponseData<operations["researchScorecard"]>
    >
>;
export type _KeysResearchPortfolioForecast = Expect<
    KeysSubsetOf<
        PortfolioForecast,
        ResponseData<operations["researchPortfolioForecast"]>
    >
>;
export type _KeysResearchMappings = Expect<
    KeysSubsetOf<
        MappingsResponse,
        ResponseData<operations["researchListMappings"]>
    >
>;
export type _KeysResearchSavedMappings = Expect<
    KeysSubsetOf<
        MappingsResponse,
        ResponseData<operations["researchSaveMappings"]>
    >
>;
export type _KeysResearchMapping = Expect<
    KeysSubsetOf<
        InstrumentProviderMapping,
        Schemas["InstrumentProviderMapping"]
    >
>;
export type _KeysResearchMappingResolve = Expect<
    KeysSubsetOf<
        MappingResolveResponse,
        ResponseData<operations["researchResolveMappings"]>
    >
>;
export type _KeysResearchMappingAudit = Expect<
    KeysSubsetOf<
        MappingAuditResponse,
        ResponseData<operations["researchAuditMappings"]>
    >
>;
export type _KeysResearchProviderKeys = Expect<
    KeysSubsetOf<
        ProviderKeysResponse,
        ResponseData<operations["researchListProviderKeys"]>
    >
>;
export type _KeysResearchSetProviderKey = Expect<
    KeysSubsetOf<
        ProviderKeysResponse,
        ResponseData<operations["researchSetProviderKey"]>
    >
>;
export type _KeysResearchAnalystConsensus = Expect<
    KeysSubsetOf<ResearchAnalystConsensus, Schemas["ResearchAnalystConsensus"]>
>;
export type _KeysResearchAnalystAction = Expect<
    KeysSubsetOf<ResearchAnalystAction, Schemas["ResearchAnalystAction"]>
>;
export type _KeysResearchNewsArticle = Expect<
    KeysSubsetOf<ResearchNewsArticle, Schemas["ResearchNewsArticle"]>
>;
export type _KeysResearchMappingProposal = Expect<
    KeysSubsetOf<MappingProposal, Schemas["ResearchMappingProposal"]>
>;
export type _KeysResearchMappingCandidate = Expect<
    KeysSubsetOf<MappingProposalCandidate, Schemas["ResearchSearchItem"]>
>;
export type _KeysResearchAuditQuote = Expect<
    KeysSubsetOf<
        MappingAuditQuote,
        Schemas["ResearchMappingAuditData"]["quotes"][number]
    >
>;
export type _KeysResearchProviderKeyStatus = Expect<
    KeysSubsetOf<ProviderKeyStatus, Schemas["ResearchProviderKeyStatus"]>
>;
export type _KeysResearchScorecardBody = Expect<
    KeysSubsetOf<ResearchScorecard, Schemas["ResearchScorecard"]>
>;
export type _KeysResearchScorecardFlag = Expect<
    KeysSubsetOf<ScorecardFlag, Schemas["ResearchScorecardFlag"]>
>;
export type _KeysResearchForecastPoint = Expect<
    KeysSubsetOf<ForecastPoint, Schemas["ResearchForecastPoint"]>
>;
export type _KeysResearchForecastHolding = Expect<
    KeysSubsetOf<
        ForecastForwardHolding,
        Schemas["ResearchForecastForwardHolding"]
    >
>;
export type _KeysResearchMeta = Expect<
    KeysSubsetOf<ResearchMeta, Schemas["ResearchMeta"]>
>;
export type _KeysResearchSearchItem = Expect<
    KeysSubsetOf<ResearchSearchItem, Schemas["ResearchSearchItem"]>
>;
export type _KeysResearchChartPoint = Expect<
    KeysSubsetOf<ResearchChartPoint, Schemas["ResearchChartPoint"]>
>;
export type _KeysResearchMacroSeriesItem = Expect<
    KeysSubsetOf<MacroSeriesItem, Schemas["ResearchMacroSeriesItem"]>
>;
export type _KeysResearchForecastProjected = Expect<
    KeysSubsetOf<
        NonNullable<PortfolioForecast["projected"]>,
        Schemas["ResearchForecastProjected"]
    >
>;
export type _KeysResearchScorecardCounts = Expect<
    KeysSubsetOf<
        ResearchScorecard["counts"],
        Schemas["ResearchScorecard"]["counts"]
    >
>;
export type _KeysUpdateCheckStatus = Expect<
    KeysSubsetOf<
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
