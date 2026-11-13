import Foundation
import VisionNativeCore

// The rows the portfolio import reconciliation plan is pure over (ADR-270): Swift forms of
// the row contracts in `database/rows/portfolioImport.ts` and `database/rows/portfolio.ts`.
// NUMERIC columns stay exact decimal text and dates stay `YYYY-MM-DD` text, as the
// TypeScript rows hold them.

/// A text column with a known vocabulary that still has to carry any stored value: the
/// TypeScript code compares these strings, so an unknown one must compare unequal, not fail.
protocol OpenLabel: RawRepresentable, Hashable, Sendable, CustomStringConvertible where RawValue == String {
    init(rawValue: String)
}

extension OpenLabel {
    var description: String { rawValue }
}

/// `portfolio_import_staging_rows.status`.
struct StagingStatus: OpenLabel {
    let rawValue: String
    static let matched = StagingStatus(rawValue: "matched")
    static let committed = StagingStatus(rawValue: "committed")
    static let duplicate = StagingStatus(rawValue: "duplicate")

    /// `["committed", "duplicate"].includes(status)`: nothing left to plan.
    var isSettled: Bool { self == .committed || self == .duplicate }
}

/// `portfolio_import_staging_rows.route`.
struct StagingRoute: OpenLabel {
    let rawValue: String
    static let cash = StagingRoute(rawValue: "cash")
    static let portfolio = StagingRoute(rawValue: "portfolio")
    static let accountInternal = StagingRoute(rawValue: "account_internal")
    static let assetTransfer = StagingRoute(rawValue: "asset_transfer")
    static let assetAdjustment = StagingRoute(rawValue: "asset_adjustment")
}

/// A `portfolio_txn_type`, or the custody event kinds reconciliation history adds.
struct PortfolioEventKind: OpenLabel {
    let rawValue: String
    static let buy = PortfolioEventKind(rawValue: "buy")
    static let sell = PortfolioEventKind(rawValue: "sell")
    static let gift = PortfolioEventKind(rawValue: "gift")
    static let split = PortfolioEventKind(rawValue: "split")
    static let dividend = PortfolioEventKind(rawValue: "dividend")
    static let interest = PortfolioEventKind(rawValue: "interest")
    static let assetTransfer = PortfolioEventKind(rawValue: "asset_transfer")
    static let assetAdjustment = PortfolioEventKind(rawValue: "asset_adjustment")

    /// `PORTFOLIO_TXN_TYPES` of `packages/types/src/portfolioTxnTypes.ts`.
    static let transactionTypes: Set<String> = [
        "buy", "sell", "dividend", "fee", "tax", "interest", "rent_income", "appreciation", "gift", "split", "merger",
        "spinoff", "return_of_capital",
    ]

    var isCustodyEvent: Bool { self == .assetTransfer || self == .assetAdjustment }
}

/// The `format` key of a batch's `custom_config`: the specialized export a batch was read as.
struct ImportFormat: OpenLabel {
    let rawValue: String
    static let saxoTransactionHistory = ImportFormat(rawValue: "saxo_transaction_history")
    static let ibkrTransactionHistory = ImportFormat(rawValue: "ibkr_transaction_history")
    static let ibkrFundingHistory = ImportFormat(rawValue: "ibkr_funding_history")
    static let nexoTransactionHistory = ImportFormat(rawValue: "nexo_transaction_history")
    static let nexoProSpotHistory = ImportFormat(rawValue: "nexo_pro_spot_history")
    static let kinesisTransactionHistory = ImportFormat(rawValue: "kinesis_transaction_history")
}

/// A reviewer's adoption policy, or the `exact` a plan records when nothing differs.
enum AdoptionPolicy: String, Sendable, Hashable {
    case exact
    case preserveExisting = "preserve_existing"
    case preferSource = "prefer_source"

    /// `isPolicy`: the two values a reviewer may choose.
    var isReviewerChoice: Bool { self != .exact }
}

/// The owner's answer for one staged row that resembles an existing transaction.
enum RowChoiceAnswer: String, Sendable, Hashable {
    case keepBoth = "keep_both"
    case sameTransaction = "same_transaction"
}

/// A ledger transaction a plan names: a `portfolio_transactions.id`, a brokerage cash
/// `transactions.id`, or a custody event's id, depending on the ledger the row belongs to.
enum LedgerTransactionIDTag: IdentifierTag {}
typealias LedgerTransactionID = IntIdentifier<LedgerTransactionIDTag>

/// `custom_config` as a column read returns it (`storedBatchConfigSchema`): the object stage
/// writes, or the JSON text older rows hold.
enum StoredBatchConfig: Equatable, Sendable {
    case object(JSObject)
    case text(String)

    /// `batchConfigFields`: the object itself, and no fields for a JSON string.
    var fields: JSObject {
        if case .object(let object) = self { return object }
        return JSObject()
    }

    /// `storedConfigObject`: the object, or the object its text parses to, else no keys.
    var parsedObject: JSObject {
        switch self {
        case .object(let object): return object
        case .text(let text): return JSValue.parse(text)?.objectValue ?? JSObject()
        }
    }
}

extension Optional where Wrapped == StoredBatchConfig {
    /// `batchConfigFields(config)?.format` when it is a string.
    var fieldsFormat: ImportFormat? {
        self?.fields["format"]?.stringValue.map(ImportFormat.init(rawValue:))
    }

    /// The reconciliation service's `formatOf`: the `format` key of the object, or of the
    /// object a JSON string parses to. `nil` unless it is a string.
    var parsedFormat: ImportFormat? {
        self?.parsedObject["format"]?.stringValue.map(ImportFormat.init(rawValue:))
    }

    /// `batchConfigFields(config)?.source_columns` when it is an array.
    var sourceColumns: [JSValue]? {
        guard case .array(let columns)? = self?.fields["source_columns"] else { return nil }
        return columns
    }
}

/// The staged columns both a staging row and a ledger source row carry, which the
/// cross-format rules read from either.
protocol CrossFormatSource {
    var id: PortfolioImportRowID { get }
    var route: StagingRoute? { get }
    var kind: PortfolioEventKind? { get }
    var kindRaw: String? { get }
    var day: String? { get }
    var units: String? { get }
    var amount: String? { get }
    var currency: CurrencyCode? { get }
    var rawData: String? { get }
    var sourceReference: String? { get }
    var sourceAccountIdentity: String? { get }
    var dedupFingerprint: String? { get }
    var dedupFingerprintVersion: Int? { get }
    var investmentID: InvestmentID? { get }
    var optionalAccountID: AccountID? { get }
    var customConfig: StoredBatchConfig? { get }
}

extension CrossFormatSource {
    /// `version:fingerprint`, the identity a ledger transaction carries; `nil` without one.
    var identity: String? {
        guard let dedupFingerprint, !dedupFingerprint.isEmpty else { return nil }
        return "\(dedupFingerprintVersion.map(String.init) ?? "null"):\(dedupFingerprint)"
    }
}

/// A staged row with its batch and resolved investment (`reconciliationSourceRowSchema`).
struct ReconciliationSourceRow: CrossFormatSource, Equatable, Sendable {
    var id: PortfolioImportRowID
    var batchID: PortfolioImportBatchNumericID
    var rowIndex: Int
    var status: StagingStatus
    var route: StagingRoute?
    /// `type`: the normalized transaction type VALIDATE stamped.
    var kind: PortfolioEventKind?
    /// `type_raw`: the statement's own label.
    var kindRaw: String?
    /// `tx_date`
    var day: String?
    var amount: String?
    var units: String?
    var pricePerUnit: String?
    var fees: String?
    var taxes: String?
    var currency: CurrencyCode?
    var fxRateToEUR: String?
    var note: String?
    var rawData: String?
    var symbolRaw: String?
    /// `source_transaction_id`: the export's own text, not a Vision entity id.
    var sourceReference: String?
    var sourceAccountIdentity: String?
    var sourceRecordHash: String?
    var dedupFingerprint: String?
    var dedupFingerprintVersion: Int?
    var assetTransferDetails: JSObject?
    var assetAdjustmentDetails: JSObject?
    var investmentID: InvestmentID?
    var resolvedInvestmentID: InvestmentID?
    var userOverrideInvestmentID: InvestmentID?
    var assetClass: String?
    var investmentCurrency: CurrencyCode?
    var accountID: AccountID?
    var customConfig: StoredBatchConfig?

    var optionalAccountID: AccountID? { accountID }
}

/// Which ledger a settled source row's event lives in.
enum SourceLedger: String, Sendable, Hashable {
    case portfolio
    case cash
}

/// A settled row of another batch whose ledger event still exists
/// (`crossFormatLedgerSourceRowSchema`).
struct CrossFormatLedgerSourceRow: CrossFormatSource, Equatable, Sendable {
    var id: PortfolioImportRowID
    var batchID: PortfolioImportBatchNumericID
    var status: StagingStatus
    var route: StagingRoute?
    var kind: PortfolioEventKind?
    var kindRaw: String?
    var day: String?
    var units: String?
    var amount: String?
    var currency: CurrencyCode?
    var rawData: String?
    var sourceReference: String?
    var sourceAccountIdentity: String?
    var dedupFingerprint: String?
    var dedupFingerprintVersion: Int?
    var investmentID: InvestmentID?
    var accountID: AccountID
    var customConfig: StoredBatchConfig?
    var ledger: SourceLedger
    var transactionID: LedgerTransactionID
    var ledgerDay: String?
    var ledgerAmount: String?
    var ledgerCurrency: CurrencyCode?

    var optionalAccountID: AccountID? { accountID }
}

/// An active cash transaction that no import owns (`manualCashCandidateRowSchema`).
struct ManualCashCandidateRow: Equatable, Sendable {
    var id: LedgerTransactionID
    var accountID: AccountID
    var day: String
    var amount: String
    var currency: CurrencyCode
}

/// A selected batch (`reconciliationBatchScopeRowSchema`); only the columns the plan reads.
struct ReconciliationBatchScopeRow: Equatable, Sendable {
    var id: PortfolioImportBatchNumericID
    var accountID: AccountID?
    var customConfig: StoredBatchConfig?
}

/// One reconciliation history event: a portfolio transaction snapshot
/// (`portfolioTransactionSnapshotSchema`), or a custody event (an asset transfer or
/// adjustment), which lacks some transaction columns and adds its own.
struct HistoryImage: Equatable, Sendable {
    var id: LedgerTransactionID
    var investmentID: InvestmentID
    var kind: PortfolioEventKind
    var day: String
    var amount: String?
    var units: String?
    var pricePerUnit: String?
    var fees: String?
    var taxes: String?
    var currency: CurrencyCode?
    var fxRateToEUR: String?
    var accountID: AccountID?
    var note: String?
    var dividendAmountConvention: String?
    var isRecurring: Bool?
    var recurrenceInterval: String?
    var recurrenceEndDay: String?
    var importBatchID: PortfolioImportBatchID?
    var sourceRecordHash: String?
    var dedupFingerprint: String?
    var dedupFingerprintVersion: Int?
    // Custody events only.
    var sourceAccountID: AccountID?
    var destinationAccountID: AccountID?
    var feeUnits: String?
    var adjustmentKind: String?
    var basisPolicy: String?

    /// `${dedup_fingerprint_version}:${dedup_fingerprint}` as JavaScript renders it, with
    /// `null` for a missing part: manual transactions all share `null:null`.
    var identityKey: String {
        "\(dedupFingerprintVersion.map(String.init) ?? "null"):\(dedupFingerprint ?? "null")"
    }
}
