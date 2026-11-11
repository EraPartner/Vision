import Foundation
import VisionNativeCore

// MARK: - Input

/// One statement's adoption policy as the request states it; `nil` and unknown values are
/// what the plan's validation refuses.
struct BatchPolicyInput: Equatable, Sendable {
    /// `nil` when the request's `batchId` is not a safe integer.
    var batchID: PortfolioImportBatchNumericID?
    var adoptPolicy: String
}

/// The owner's answer for one staged row as the request states it.
struct RowChoiceInput: Equatable, Sendable {
    var batchID: PortfolioImportBatchNumericID?
    var rowID: PortfolioImportRowID?
    var choice: String
}

/// The pre-read evidence and selection the plan builder is pure over
/// (`ReconciliationPlanInput`).
struct ReconciliationPlanInput: Equatable, Sendable {
    var rows: [ReconciliationSourceRow]
    var history: [HistoryImage]
    var batches: [ReconciliationBatchScopeRow]
    var adoptPolicy: String?
    var batchPolicies: [BatchPolicyInput] = []
    var priorProAccounts: [AccountID] = []
    /// Ledger evidence for rows another export or a manual entry records.
    var crossFormat: CrossFormatContext?
    /// Every `format\0source id` an imported history transaction was recorded from, for the
    /// specialized export formats only.
    var historySourceKeys: [LedgerTransactionID: [String]] = [:]
    /// The owner's answer for rows that resemble an existing transaction.
    var rowChoices: [RowChoiceInput] = []
}

// MARK: - Output

/// A validated statement policy.
struct BatchPolicy: Equatable, Sendable {
    var batchID: PortfolioImportBatchNumericID
    var adoptPolicy: AdoptionPolicy
}

/// The owner's answer for one staged row that resembles an existing transaction no import
/// can adopt: `keep_both` records it as a new transaction, `same_transaction` settles it as
/// a duplicate of that one.
struct RowChoice: Equatable, Sendable {
    var batchID: PortfolioImportBatchNumericID
    var rowID: PortfolioImportRowID
    var choice: RowChoiceAnswer
}

/// What a staged row becomes. The declaration order is the order of `plan.summary`.
enum PlanActionKind: String, Sendable, Hashable, CaseIterable {
    case insert
    case adopt
    case duplicate
    case duplicateSource = "duplicate_source"
    case cash
    case transfer
    case adjustment
    case internalAnnotation = "internal_annotation"
    case settled
    case blocked
    case policyRequired = "policy_required"
}

/// A column a plan compares between the staged source and the existing transaction.
enum PlanValueField: String, Sendable, Hashable, CaseIterable {
    case type
    case date
    case amount
    case units
    case pricePerUnit = "price_per_unit"
    case fees
    case taxes
    case currency
    case fxRateToEUR = "fx_rate_to_eur"
    case dividendAmountConvention = "dividend_amount_convention"

    /// `VALUE_FIELDS`: every field but the type, which adoption never rewrites.
    static let valueFields = allCases.filter { $0 != .type }

    /// `PLACES`: the staging precision of a NUMERIC column.
    var places: Int? {
        switch self {
        case .amount, .fees, .taxes: return 4
        case .units: return 8
        case .pricePerUnit: return 6
        case .fxRateToEUR: return 10
        case .type, .date, .currency, .dividendAmountConvention: return nil
        }
    }
}

/// `publicValues`: the type and value columns of a staged source or an existing transaction.
struct PlanTransactionValues: Equatable, Sendable {
    var type: String?
    var date: String?
    var amount: String?
    var units: String?
    var pricePerUnit: String?
    var fees: String?
    var taxes: String?
    var currency: String?
    var fxRateToEUR: String?
    var dividendAmountConvention: String?

    init(_ source: NormalizedSource) {
        type = source.kind?.rawValue
        date = source.day
        amount = source.amount
        units = source.units
        pricePerUnit = source.pricePerUnit
        fees = source.fees
        taxes = source.taxes
        currency = source.currency.rawValue
        fxRateToEUR = source.fxRateToEUR
        dividendAmountConvention = source.dividendAmountConvention
    }

    init(_ current: HistoryImage) {
        type = current.kind.rawValue
        date = current.day
        amount = current.amount
        units = current.units
        pricePerUnit = current.pricePerUnit
        fees = current.fees
        taxes = current.taxes
        currency = current.currency?.rawValue
        fxRateToEUR = current.fxRateToEUR
        dividendAmountConvention = current.dividendAmountConvention
    }

    subscript(field: PlanValueField) -> String? {
        switch field {
        case .type: return type
        case .date: return date
        case .amount: return amount
        case .units: return units
        case .pricePerUnit: return pricePerUnit
        case .fees: return fees
        case .taxes: return taxes
        case .currency: return currency
        case .fxRateToEUR: return fxRateToEUR
        case .dividendAmountConvention: return dividendAmountConvention
        }
    }
}

/// The `source` or `existing` values a planned row shows.
enum PlanValues: Equatable, Sendable {
    /// A portfolio transaction's columns. `includedInUnits` marks in-kind income
    /// (`income_recognition_role: "included_in_units"`).
    case transaction(PlanTransactionValues, includedInUnits: Bool)
    /// A brokerage cash movement.
    case cash(day: String?, amount: String, currency: CurrencyCode)
}

/// A plan blocker (`PlanIssue`).
struct PlanIssue: Equatable, Sendable {
    var batchID: PortfolioImportBatchNumericID
    var rowID: PortfolioImportRowID
    var rowOrdinal: Int
    var reason: ReconciliationBlockReason
    var candidateTransactionIDs: [LedgerTransactionID]
}

/// One planned row outcome (`PlanAction`). `action` selects which optional fields are set.
struct PlanAction: Equatable, Sendable {
    struct Transfer: Equatable, Sendable {
        var day: String
        var units: String
        var feeUnits: String
        var receivedUnits: String
        var sourceAccountID: AccountID
        var destinationAccountID: AccountID
    }

    struct Adjustment: Equatable, Sendable {
        var day: String
        var units: String
        var kind: AssetAdjustmentEvent.Kind
        var basisPolicy: AssetAdjustmentEvent.BasisPolicy
        var accountID: AccountID
    }

    var batchID: PortfolioImportBatchNumericID
    var rowID: PortfolioImportRowID
    var rowOrdinal: Int
    var action: PlanActionKind
    var reason: ReconciliationBlockReason?
    var candidateTransactionIDs: [LedgerTransactionID]?
    /// Absent (`nil`), `null` (`.some(nil)`) for a cash row, or the staged investment.
    var investmentID: InvestmentID??
    var source: PlanValues?
    var existing: PlanValues?
    var existingTransactionID: LedgerTransactionID?
    var duplicateOfRowID: PortfolioImportRowID?
    var corrections: [PlanValueField]?
    var economicsProven: Bool?
    var policy: AdoptionPolicy?
    /// Settled by another export of the same broker or a manual cash entry.
    var crossFormat = false
    /// The existing transaction is brokerage cash, not a portfolio row.
    var cash = false
    var transfer: Transfer?
    var adjustment: Adjustment?
}

/// A planned cash adoption: a funding correction or a manual cash twin.
struct PlanCashAdoption: Equatable, Sendable {
    var row: ReconciliationSourceRow
    var decision: CashAdoptionDecision
}

/// A planned adoption of a manual portfolio transaction, with its before and after images.
struct PlanAdoption: Equatable, Sendable {
    var row: ReconciliationSourceRow
    var before: HistoryImage
    var after: HistoryImage
    var policy: AdoptionPolicy
}

struct ReconciliationPlan: Equatable, Sendable {
    var batchIDs: [PortfolioImportBatchNumericID]
    var adoptPolicy: AdoptionPolicy?
    var batchPolicies: [BatchPolicy]
    var rowChoices: [RowChoice]
    var ready: Bool
    var actions: [PlanAction]
    var blockers: [PlanIssue]

    /// `summary`: the number of actions of each kind.
    var summary: [PlanActionKind: Int] {
        var counts = Dictionary(uniqueKeysWithValues: PlanActionKind.allCases.map { ($0, 0) })
        for action in actions { counts[action.action, default: 0] += 1 }
        return counts
    }
}

struct ReconciliationPlanResult: Equatable, Sendable {
    var plan: ReconciliationPlan
    var adoptions: [PlanAdoption]
    /// Rows another export already records, or that the owner named the same transaction as
    /// an existing one; commit settles them as duplicates.
    var settledDuplicates: [ReconciliationSourceRow]
    var cashAdoptions: [PlanCashAdoption]
}

// MARK: - Plan

/// Reviewed import of broker history into a portfolio that may already hold manually entered
/// transactions (ADR-177, simplified by ADR-236): the pure plan builder of
/// `services/portfolioImportReconciliationService.ts` (ADR-270). Preview and the locked
/// commit read the evidence and call this; those database halves are not ported yet.
///
/// Every staged row gets one action. A row whose fingerprint is already in the ledger is a
/// duplicate. A row with exactly one nearby, unassigned manual candidate adopts that
/// transaction: the existing ID, type and notes stay, the row gains the source identity and
/// account, and the batch journals a before/after receipt so rollback can restore it. An
/// inexact candidate needs the reviewer's choice: keep the existing values
/// (`preserve_existing`) or use the imported ones (`prefer_source`). A row that another
/// export of the same broker, or a manual cash entry, already records is settled by the
/// cross-format rules (`PortfolioImportCrossFormat`). Everything else is inserted by the
/// ordinary commit pipeline.
enum PortfolioImportReconciliation {
    /// Ordinary nearby legacy matching window, in calendar days.
    private static let nearbyDays = 7.0
    /// Literal Nexo Pro execution proof may widen the window to this many days.
    private static let nexoProDays = 31.0
    private static let unitKinds: Set<PortfolioEventKind> = [.buy, .sell, .gift, .split]
    private static let incomeKinds: Set<PortfolioEventKind> = [.sell, .dividend, .interest]
    private static let internalDirection = "internal"
    private static let incomingDirection = "in"
    private static let nexoProSourcePrefix = "nexo-pro:spot:order:"

    // MARK: Comparisons

    /// `equalNumber`: equal at `places` decimals; two missing values are equal.
    private static func equalNumber(_ left: String?, _ right: String?, _ places: Int) throws -> Bool {
        guard let left, let right else { return left == nil && right == nil }
        return try DecimalJS.from(left).toDecimalPlaces(places).eq(try DecimalJS.from(right).toDecimalPlaces(places))
    }

    /// `sameValue`: a NUMERIC column at its staging precision, the dividend convention with
    /// `unknown` for a missing one, anything else exactly.
    private static func sameValue(_ field: PlanValueField, _ left: String?, _ right: String?) throws -> Bool {
        if field == .dividendAmountConvention {
            return (left ?? NormalizedSource.unknownConvention) == (right ?? NormalizedSource.unknownConvention)
        }
        if let places = field.places { return try equalNumber(left, right, places) }
        return left == right
    }

    /// ASCII letters lowered, everything else untouched: how a JavaScript `/i` pattern of
    /// ASCII letters reads text.
    private static func asciiLowercased(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            if scalar.value >= 0x41, scalar.value <= 0x5A, let lower = Unicode.Scalar(scalar.value + 0x20) {
                scalars.append(lower)
            } else {
                scalars.append(scalar)
            }
        }
        return String(scalars)
    }

    /// The literal CSV record, also when an earlier writer wrapped it in JSON.
    private static func literalRawData(_ rawData: String?) -> String? {
        guard let rawData, rawData.hasPrefix("{") else { return rawData }
        // Otherwise an ordinary record that starts with a brace.
        return JSValue.parse(rawData)?.objectValue?["primaryRawData"]?.stringValue ?? rawData
    }

    /// The Nexo Pro execution facts that stay literal in the staged row.
    private static func nexoProProof(_ row: ReconciliationSourceRow, _ source: NormalizedSource) throws
        -> NexoProSpotEvidence?
    {
        guard row.customConfig.parsedFormat == .nexoProSpotHistory,
            let proof = NexoProSpotEvidence.fromRawData(literalRawData(row.rawData)),
            proof.side == source.kind, proof.symbol == row.symbolRaw, proof.currency == source.currency,
            row.sourceReference == nexoProSourcePrefix + proof.sourceOrder,
            String(proof.sourceTimestamp.prefix(10)) == source.day,
            try equalNumber(proof.netUnits, source.units, 8),
            try equalNumber(proof.unitPrice, source.pricePerUnit, 6),
            try NexoProSpotEvidence.sourceMoneyMatches(literal: proof.amount, staged: source.amount),
            try NexoProSpotEvidence.sourceMoneyMatches(literal: proof.quoteFee, staged: source.fees),
            try equalNumber("0", source.taxes, 4)
        else { return nil }
        return proof
    }

    /// A base-currency fee charged in units explains a gross/net unit difference.
    private static func proFeeExplainsUnits(_ proof: NexoProSpotEvidence?, _ current: HistoryImage) throws -> Bool {
        guard let proof, proof.feeAsset == proof.symbol, try DecimalJS.from(proof.feeUnits).gt(.zero) else {
            return false
        }
        return try equalNumber(proof.grossUnits, current.units, 8)
    }

    private static func transferWithoutBasis(_ row: ReconciliationSourceRow) -> Bool {
        if row.assetTransferDetails?["direction"]?.stringValue == incomingDirection { return true }
        guard row.kind == .gift else { return false }
        let note = asciiLowercased(row.note ?? "")
        return note.contains("original cost basis unavailable") || note.contains("asset transfer in")
    }

    private static func plausibleUnits(_ left: String?, _ right: String?) throws -> Bool {
        guard let left, let right else { return left == nil && right == nil }
        let floor = try DecimalJS("0.00000001")
        let value = try DecimalJS.from(left)
        let relative = value.abs.times(floor)
        let tolerance = relative.gt(floor) ? relative : floor
        return value.minus(try DecimalJS.from(right)).abs.lte(tolerance)
    }

    /// The imported and recorded amounts describe the same money.
    private static func equivalentEconomics(
        _ source: NormalizedSource, _ current: HistoryImage, _ proof: NexoProSpotEvidence?
    ) throws -> Bool {
        let amount = try DecimalJS.from(source.amount)
        let fees = try DecimalJS.from(source.fees)
        let taxes = try DecimalJS.from(source.taxes)
        let signed =
            source.kind.map(incomeKinds.contains) == true
            ? amount.minus(fees).minus(taxes) : amount.plus(fees).plus(taxes)
        var sourceAmounts: [String?] = [source.amount, signed.toFixed]
        if let proof { sourceAmounts.append(proof.grossQuoteAmount) }
        if source.currency == current.currency {
            return try sourceAmounts.contains { try equalNumber($0, current.amount, 4) }
        }
        guard let sourceRate = source.currency == .eur ? "1" : source.fxRateToEUR else { return false }
        let currentEUR: String?
        if current.currency == .eur {
            currentEUR = current.amount
        } else if let rate = current.fxRateToEUR {
            currentEUR = try DecimalJS.from(current.amount).times(try DecimalJS.from(rate)).toFixed
        } else {
            return false
        }
        let rate = try DecimalJS.from(sourceRate)
        return try sourceAmounts.contains {
            try equalNumber(try DecimalJS.from($0).times(rate).toFixed, currentEUR, 4)
        }
    }

    /// A manual transaction that may record the same event as the staged row.
    private static func nearbyCandidate(
        _ row: ReconciliationSourceRow, _ source: NormalizedSource, _ current: HistoryImage,
        _ proof: NexoProSpotEvidence?
    ) throws -> Bool {
        guard row.investmentID == current.investmentID else { return false }
        let distance = ImportInterop.dayDistance(source.day, current.day)
        if distance > nearbyDays {
            guard let proof, distance <= nexoProDays, source.kind == current.kind,
                try equalNumber(source.units, current.units, 8) || proFeeExplainsUnits(proof, current),
                try equalNumber(proof.unitPrice, current.pricePerUnit, 6),
                try equivalentEconomics(source, current, proof)
            else { return false }
        }
        let transfer = transferWithoutBasis(row)
        if source.kind != current.kind, !(transfer && (current.kind == .buy || current.kind == .gift)) { return false }
        guard let kind = source.kind, unitKinds.contains(kind) else { return true }
        if try plausibleUnits(source.units, current.units) { return true }
        if let price = source.pricePerUnit, let currentPrice = current.pricePerUnit,
            try DecimalJS.from(price).gt(.zero), try equalNumber(price, currentPrice, 6),
            try equivalentEconomics(source, current, proof)
        {
            return true
        }
        return try proFeeExplainsUnits(proof, current)
    }

    // MARK: Request validation

    private static func reviewerPolicy(_ text: String) -> AdoptionPolicy? {
        AdoptionPolicy(rawValue: text).flatMap { $0.isReviewerChoice ? $0 : nil }
    }

    /// `canonicalBatchPolicies`: at most one supported policy per selected batch, sorted.
    private static func canonicalBatchPolicies(
        _ batchPolicies: [BatchPolicyInput], _ batches: [ReconciliationBatchScopeRow]
    ) throws -> [BatchPolicy] {
        let selected = Set(batches.map(\.id))
        if batchPolicies.count > selected.count {
            throw BackendHTTPError.validation("batch_policies must contain at most one policy per selected batch")
        }
        var seen = Set<PortfolioImportBatchNumericID>()
        var canonical: [BatchPolicy] = []
        for override in batchPolicies {
            guard let batchID = override.batchID, selected.contains(batchID), seen.insert(batchID).inserted,
                let policy = reviewerPolicy(override.adoptPolicy)
            else {
                throw BackendHTTPError.validation(
                    "batch_policies must use unique selected batch IDs and supported adoption policies")
            }
            canonical.append(BatchPolicy(batchID: batchID, adoptPolicy: policy))
        }
        return canonical.sorted { $0.batchID < $1.batchID }
    }

    private struct RowKey: Hashable {
        let batchID: PortfolioImportBatchNumericID
        let rowID: PortfolioImportRowID
    }

    /// `canonicalRowChoices`: one choice per staged row of the selected batches, sorted.
    private static func canonicalRowChoices(_ rowChoices: [RowChoiceInput], _ rows: [ReconciliationSourceRow]) throws
        -> [RowChoice]
    {
        let staged = Set(rows.map { RowKey(batchID: $0.batchID, rowID: $0.id) })
        var seen = Set<RowKey>()
        var canonical: [RowChoice] = []
        for item in rowChoices {
            guard let batchID = item.batchID, let rowID = item.rowID,
                staged.contains(RowKey(batchID: batchID, rowID: rowID)),
                seen.insert(RowKey(batchID: batchID, rowID: rowID)).inserted,
                let choice = RowChoiceAnswer(rawValue: item.choice)
            else {
                throw BackendHTTPError.validation(
                    "row_choices must name distinct staged rows of the selected batches with a supported choice")
            }
            canonical.append(RowChoice(batchID: batchID, rowID: rowID, choice: choice))
        }
        return canonical.sorted { ($0.batchID, $0.rowID) < ($1.batchID, $1.rowID) }
    }

    // MARK: Builder

    /// What an earlier staged row with the same source identity was planned from.
    private enum SeenSource {
        case transaction(NormalizedSource)
        case transfer(AssetTransferEvent)
        case adjustment(AssetAdjustmentEvent)
    }

    /// A staged row with its source values and nearby manual candidates.
    private struct PreparedRow {
        let row: ReconciliationSourceRow
        let source: NormalizedSource
        let proof: NexoProSpotEvidence?
        let candidates: [HistoryImage]
        let baseAction: PlanAction
        let inKindIncome: Bool
    }

    /// `Number(row.account_id)`: a missing account is account `0`, which no account has.
    private static func accountNumber(_ id: AccountID?) -> Int { id?.rawValue ?? 0 }

    /// `buildPortfolioImportReconciliationPlan`: pure, used by preview and locked commit. No
    /// proximity match writes data.
    static func buildPlan(_ input: ReconciliationPlanInput) throws -> ReconciliationPlanResult {
        let rows = input.rows
        let history = input.history
        let batches = input.batches
        var adoptPolicy: AdoptionPolicy?
        if let requested = input.adoptPolicy {
            guard let policy = reviewerPolicy(requested) else {
                throw BackendHTTPError.validation("adopt_policy must be preserve_existing or prefer_source")
            }
            adoptPolicy = policy
        }
        let canonicalPolicies = try canonicalBatchPolicies(input.batchPolicies, batches)
        let overrides = Dictionary(canonicalPolicies.map { ($0.batchID, $0.adoptPolicy) }) { first, _ in first }
        func policyOf(_ row: ReconciliationSourceRow) -> AdoptionPolicy? { overrides[row.batchID] ?? adoptPolicy }
        let canonicalChoices = try canonicalRowChoices(input.rowChoices, rows)
        let choices = Dictionary(
            canonicalChoices.map { (RowKey(batchID: $0.batchID, rowID: $0.rowID), $0.choice) }
        ) { first, _ in first }
        func choiceOf(_ row: ReconciliationSourceRow) -> RowChoiceAnswer? {
            choices[RowKey(batchID: row.batchID, rowID: row.id)]
        }
        /// The specialized export format and normalized source id of a staged row, if it has
        /// both. A generic CSV mapping names no export: different tools share it, so its ids
        /// cannot tell two transactions apart.
        func stagedSourceKey(_ row: ReconciliationSourceRow) -> (prefix: String, key: String)? {
            let reference = ImportInterop.normalizeIdentityText(row.sourceReference)
            guard let format = row.customConfig.parsedFormat, !format.rawValue.isEmpty, !reference.isEmpty else {
                return nil
            }
            return ("\(format)\u{0}", "\(format)\u{0}\(reference)")
        }
        /// An existing transaction may record the same event as the staged row only on the
        /// same account (or none yet, for a manual entry an import adopts), and never when it
        /// was recorded from the same export format under a different source id. Ids of
        /// another format say nothing either way.
        func mayRecordSameEvent(_ row: ReconciliationSourceRow, _ current: HistoryImage) -> Bool {
            if let account = current.accountID, account.rawValue != accountNumber(row.accountID) { return false }
            // Custody events number their own table; the ids name transactions.
            guard !current.kind.isCustodyEvent, let recorded = input.historySourceKeys[current.id],
                let staged = stagedSourceKey(row)
            else { return true }
            let sameFormat = recorded.filter { $0.hasPrefix(staged.prefix) }
            return sameFormat.isEmpty || sameFormat.contains(staged.key)
        }
        var actions: [PlanAction] = []
        var blockers: [PlanIssue] = []
        var adoptions: [PlanAdoption] = []
        var settledDuplicates: [ReconciliationSourceRow] = []
        var cashAdoptions: [PlanCashAdoption] = []
        var prepared: [PreparedRow] = []
        let crossFormatDecisions =
            try input.crossFormat.map {
                try PortfolioImportCrossFormat.plan(rows: rows, context: $0, policyOf: policyOf, rowChoiceOf: choiceOf)
            } ?? [:]
        // Dividend rows that a zero-basis Kinesis yield gift already represents.
        let zeroYieldBatches = Set(
            batches.filter { KinesisInKindIncome.isZeroYieldBatch($0.customConfig) }.map(\.id))
        var inKindIncome = Set<PortfolioImportRowID>()
        for batch in zeroYieldBatches {
            inKindIncome.formUnion(KinesisInKindIncome.incomeRowIDs(rows.filter { $0.batchID == batch }))
        }
        var seenSources: [String: (row: ReconciliationSourceRow, source: SeenSource)] = [:]
        var proAccounts = Set(input.priorProAccounts.map(\.rawValue))
        for row in rows
        where row.customConfig.parsedFormat == .nexoProSpotHistory && row.route == .portfolio
            && (row.kind == .buy || row.kind == .sell) && (row.status == .matched || row.status.isSettled)
        {
            proAccounts.insert(accountNumber(row.accountID))
        }
        func rowAction(_ row: ReconciliationSourceRow, _ kind: PlanActionKind) -> PlanAction {
            PlanAction(batchID: row.batchID, rowID: row.id, rowOrdinal: row.rowIndex + 1, action: kind)
        }
        func addIssue(
            _ row: ReconciliationSourceRow, _ reason: ReconciliationBlockReason, _ candidates: [LedgerTransactionID]
        ) {
            blockers.append(
                PlanIssue(
                    batchID: row.batchID, rowID: row.id, rowOrdinal: row.rowIndex + 1, reason: reason,
                    candidateTransactionIDs: candidates))
        }
        func addBlocker(
            _ row: ReconciliationSourceRow, _ reason: ReconciliationBlockReason,
            _ candidates: [LedgerTransactionID] = []
        ) {
            addIssue(row, reason, candidates)
            var action = rowAction(row, .blocked)
            action.reason = reason
            action.candidateTransactionIDs = candidates
            actions.append(action)
        }
        // The first history row per fingerprint identity.
        var historyByIdentity: [String: HistoryImage] = [:]
        for current in history where historyByIdentity[current.identityKey] == nil {
            historyByIdentity[current.identityKey] = current
        }
        /// A custody event: a ledger duplicate, an in-session duplicate, or new.
        func custodyAction(
            _ row: ReconciliationSourceRow, identity: String, event: SeenSource,
            sameAsHistory: (HistoryImage) throws -> Bool, sameAsEarlier: (SeenSource) throws -> Bool,
            kind: PlanActionKind, detail: (inout PlanAction) -> Void
        ) throws {
            let canonical = historyByIdentity[identity]
            if let canonical, try !sameAsHistory(canonical) {
                addBlocker(row, .sourceIdentityConflict, [canonical.id])
                return
            }
            let earlier = seenSources[identity]
            if let earlier, try !sameAsEarlier(earlier.source) {
                addBlocker(row, .sourceIdentityConflict)
                return
            }
            var action = rowAction(row, canonical != nil ? .duplicate : (earlier != nil ? .duplicateSource : kind))
            action.investmentID = .some(InvestmentID(rawValue: row.investmentID?.rawValue ?? 0))
            detail(&action)
            action.existingTransactionID = canonical?.id
            action.duplicateOfRowID = earlier?.row.id
            actions.append(action)
            if canonical == nil, earlier == nil { seenSources[identity] = (row, event) }
        }

        for row in rows {
            if row.status.isSettled {
                actions.append(rowAction(row, .settled))
                continue
            }
            let crossDecision = crossFormatDecisions[row.id]
            var keptApart: [LedgerTransactionID] = []
            // A row kept apart from its near match takes the ordinary path below.
            if case .keptApart(let transactionIDs)? = crossDecision {
                keptApart = transactionIDs
            } else if let decision = crossDecision {
                var base = rowAction(row, .blocked)
                base.investmentID = .some(row.investmentID)
                base.crossFormat = true
                func cashAction(
                    _ kind: PlanActionKind, transactionID: LedgerTransactionID, existing: CashLedgerValues,
                    source: CashValue
                ) throws -> PlanAction {
                    var corrections: [PlanValueField] = []
                    if row.day != existing.day { corrections.append(.date) }
                    if try !equalNumber(source.amount, existing.amount, 4) { corrections.append(.amount) }
                    if source.currency != existing.currency { corrections.append(.currency) }
                    var action = base
                    action.action = kind
                    action.investmentID = .some(nil)
                    action.cash = true
                    action.existingTransactionID = transactionID
                    action.existing = .cash(day: existing.day, amount: existing.amount, currency: existing.currency)
                    action.source = .cash(day: row.day, amount: source.amount, currency: source.currency)
                    action.corrections = corrections
                    return action
                }
                switch decision {
                case .keptApart: break
                case .blocked(let reason, let candidates): addBlocker(row, reason, candidates)
                case .duplicateSource(let rowID, let policy):
                    base.action = .duplicateSource
                    base.duplicateOfRowID = rowID
                    // A near match the owner paired by choosing prefer_source.
                    base.policy = policy
                    actions.append(base)
                    settledDuplicates.append(row)
                case .duplicate(let transactionID, let policy):
                    base.action = .duplicate
                    base.existingTransactionID = transactionID
                    base.policy = policy
                    actions.append(base)
                    settledDuplicates.append(row)
                case .policyRequired(let transactionID, let existing):
                    actions.append(
                        try cashAction(
                            .policyRequired, transactionID: transactionID, existing: existing,
                            source: CashValue(amount: existing.amount, currency: existing.currency)))
                    addIssue(row, .sourcePolicyRequired, [transactionID])
                case .adoptCash(let adoption):
                    var action = try cashAction(
                        .adopt, transactionID: adoption.transactionID, existing: adoption.existing,
                        source: adoption.after)
                    action.policy = adoption.policy
                    actions.append(action)
                    cashAdoptions.append(PlanCashAdoption(row: row, decision: adoption))
                }
                continue
            }
            let custodyOrCashRoutes: Set<StagingRoute> = [.cash, .accountInternal, .assetTransfer, .assetAdjustment]
            let routed = row.route.map(custodyOrCashRoutes.contains) ?? false
            guard row.status == .matched, let day = row.day, !day.isEmpty,
                routed || ((row.kind.map { !$0.rawValue.isEmpty } ?? false) && row.investmentID != nil)
            else {
                addBlocker(row, .incompleteSource)
                continue
            }
            if row.route == .accountInternal {
                // A Nexo wallet-to-Pro movement is an annotation inside one account; the
                // companion Pro trade history supplies its economic events.
                if row.customConfig.parsedFormat != .nexoTransactionHistory
                    || row.assetTransferDetails?["direction"]?.stringValue != internalDirection
                {
                    addBlocker(row, .invalidInternalAnnotation)
                } else if !proAccounts.contains(accountNumber(row.accountID)) {
                    addBlocker(row, .missingCompanionProHistory)
                } else {
                    actions.append(rowAction(row, .internalAnnotation))
                }
                continue
            }
            if row.route == .cash {
                if row.accountID == nil || row.amount == nil {
                    addBlocker(row, .incompleteSource)
                } else if let identity = row.identity,
                    input.crossFormat?.cashFingerprints.contains(identity) == true
                        || input.crossFormat?.correctedAliases.contains(identity) == true
                {
                    // Commit settles a movement the cash ledger already holds as a duplicate.
                    var action = rowAction(row, .duplicate)
                    action.cash = true
                    actions.append(action)
                } else {
                    actions.append(rowAction(row, .cash))
                }
                continue
            }
            if row.route == .assetAdjustment {
                switch try PortfolioCustodyPreviews.assetAdjustment(row) {
                case .error(let reason): addBlocker(row, reason)
                case .event(let event):
                    func same(
                        investment: InvestmentID?, account: AccountID?, day: String?, kind: String?, policy: String?,
                        units: String?
                    ) throws -> Bool {
                        try investment == event.investmentID && account == event.accountID && day == event.day
                            && kind == event.kind.rawValue && policy == event.basisPolicy.rawValue
                            && equalNumber(units, event.units, 8)
                    }
                    try custodyAction(
                        row, identity: "\(event.dedupFingerprintVersion):\(event.dedupFingerprint)",
                        event: .adjustment(event),
                        sameAsHistory: { current in
                            try current.kind == .assetAdjustment
                                && same(
                                    investment: current.investmentID, account: current.accountID, day: current.day,
                                    kind: current.adjustmentKind, policy: current.basisPolicy, units: current.units)
                        },
                        sameAsEarlier: { earlier in
                            guard case .adjustment(let other) = earlier else { return false }
                            return try same(
                                investment: other.investmentID, account: other.accountID, day: other.day,
                                kind: other.kind.rawValue, policy: other.basisPolicy.rawValue, units: other.units)
                        },
                        kind: .adjustment
                    ) { action in
                        action.adjustment = .init(
                            day: event.day, units: event.units, kind: event.kind, basisPolicy: event.basisPolicy,
                            accountID: event.accountID)
                    }
                }
                continue
            }
            if row.route == .assetTransfer {
                switch try PortfolioCustodyPreviews.assetTransfer(row) {
                case .error(let reason): addBlocker(row, reason)
                case .event(let event):
                    func same(
                        investment: InvestmentID?, source: AccountID?, destination: AccountID?, day: String?,
                        units: String?, feeUnits: String?
                    ) throws -> Bool {
                        try investment == event.investmentID && source == event.sourceAccountID
                            && destination == event.destinationAccountID && day == event.day
                            && equalNumber(units, event.units, 8) && equalNumber(feeUnits, event.feeUnits, 8)
                    }
                    try custodyAction(
                        row, identity: "\(event.dedupFingerprintVersion):\(event.dedupFingerprint)",
                        event: .transfer(event),
                        sameAsHistory: { current in
                            try current.kind == .assetTransfer
                                && same(
                                    investment: current.investmentID, source: current.sourceAccountID,
                                    destination: current.destinationAccountID, day: current.day, units: current.units,
                                    feeUnits: current.feeUnits)
                        },
                        sameAsEarlier: { earlier in
                            guard case .transfer(let other) = earlier else { return false }
                            return try same(
                                investment: other.investmentID, source: other.sourceAccountID,
                                destination: other.destinationAccountID, day: other.day, units: other.units,
                                feeUnits: other.feeUnits)
                        },
                        kind: .transfer
                    ) { action in
                        action.transfer = .init(
                            day: event.day, units: event.units, feeUnits: event.feeUnits,
                            receivedUnits: (try? DecimalJS.from(event.units).minus(DecimalJS.from(event.feeUnits)).toFixed)
                                ?? event.units,
                            sourceAccountID: event.sourceAccountID, destinationAccountID: event.destinationAccountID)
                    }
                }
                continue
            }
            let source: NormalizedSource
            do {
                source = try NormalizedSource(row)
            } catch {
                addBlocker(row, .invalidSourceValues)
                continue
            }
            let identity = row.identity
            let income = inKindIncome.contains(row.id)
            if !income, zeroYieldBatches.contains(row.batchID), KinesisInKindIncome.isIncomeDividend(row) {
                addBlocker(row, .pairedIncomeUnitsMissing)
                continue
            }
            var baseAction = rowAction(row, .insert)
            baseAction.investmentID = .some(InvestmentID(rawValue: row.investmentID?.rawValue ?? 0))
            baseAction.source = .transaction(PlanTransactionValues(source), includedInUnits: income)
            if let identity, let canonical = historyByIdentity[identity] {
                if canonical.investmentID != row.investmentID || canonical.accountID != row.accountID {
                    addBlocker(row, .sourceIdentityConflict, [canonical.id])
                } else {
                    var action = baseAction
                    action.action = .duplicate
                    action.existingTransactionID = canonical.id
                    actions.append(action)
                }
                continue
            }
            if let identity, let earlier = seenSources[identity] {
                if policyOf(earlier.row) != policyOf(row) {
                    addBlocker(row, .sourcePolicyConflict)
                } else if case .transaction(let earlierSource) = earlier.source,
                    earlier.row.accountID == row.accountID, earlier.row.investmentID == row.investmentID,
                    earlierSource == source
                {
                    var action = baseAction
                    action.action = .duplicateSource
                    action.duplicateOfRowID = earlier.row.id
                    actions.append(action)
                } else {
                    addBlocker(row, .sourceIdentityConflict)
                }
                continue
            }
            if let identity { seenSources[identity] = (row, .transaction(source)) }
            let proof = try nexoProProof(row, source)
            // The owner said this row is a transaction of its own.
            let candidates =
                choiceOf(row) == .keepBoth
                ? []
                : try history.filter { current in
                    try !keptApart.contains(current.id) && mayRecordSameEvent(row, current)
                        && nearbyCandidate(row, source, current, proof)
                }
            prepared.append(
                PreparedRow(
                    row: row, source: source, proof: proof, candidates: candidates, baseAction: baseAction,
                    inKindIncome: income))
        }

        // A candidate claimed by two staged rows is ambiguous for both.
        var uses: [LedgerTransactionID: Int] = [:]
        for item in prepared {
            for candidate in item.candidates { uses[candidate.id, default: 0] += 1 }
        }
        for item in prepared {
            let row = item.row
            let source = item.source
            let proof = item.proof
            let candidates = item.candidates
            let candidateIDs = candidates.map(\.id)
            let effectivePolicy = policyOf(row)
            guard let current = candidates.first else {
                var datedProCandidates: [HistoryImage] = []
                if let proof, choiceOf(row) != .keepBoth {
                    datedProCandidates = try history.filter { current in
                        let distance = ImportInterop.dayDistance(current.day, source.day)
                        guard row.investmentID == current.investmentID, mayRecordSameEvent(row, current),
                            current.kind == source.kind, distance > nearbyDays, distance <= nexoProDays
                        else { return false }
                        if try equalNumber(proof.netUnits, current.units, 8) { return true }
                        return try proof.feeAsset == proof.symbol && equalNumber(proof.grossUnits, current.units, 8)
                    }
                }
                if !datedProCandidates.isEmpty {
                    addBlocker(
                        row, datedProCandidates.count > 1 ? .ambiguousHistory : .unprovenEconomics,
                        datedProCandidates.map(\.id))
                } else if transferWithoutBasis(row) {
                    addBlocker(row, .missingOriginalBasis)
                } else {
                    actions.append(item.baseAction)
                }
                continue
            }
            // In-kind income is recorded only as a new row with its accounting role. An
            // existing manual dividend for the same yield needs a manual decision.
            if item.inKindIncome {
                addBlocker(row, .pairedIncomeExistingConflict, candidateIDs)
                continue
            }
            if candidates.count != 1 || uses[current.id] != 1 {
                addBlocker(row, .ambiguousHistory, candidateIDs)
                continue
            }
            let existing = PlanTransactionValues(current)
            if current.accountID != nil || current.importBatchID != nil || current.dedupFingerprint != nil {
                // Another import or an account already owns it, so it cannot be adopted. Only
                // the owner can say whether the row is that transaction (settled as its
                // duplicate) or a separate one (`keep_both`, above).
                if choiceOf(row) == .sameTransaction {
                    var action = item.baseAction
                    action.action = .duplicate
                    action.existingTransactionID = current.id
                    action.existing = .transaction(existing, includedInUnits: false)
                    actions.append(action)
                    settledDuplicates.append(row)
                } else {
                    addBlocker(row, .existingAssignedOrImportedHistory, candidateIDs)
                }
                continue
            }
            guard let fingerprint = row.dedupFingerprint, !fingerprint.isEmpty,
                let fingerprintVersion = row.dedupFingerprintVersion
            else {
                addBlocker(row, .missingSourceIdentity, candidateIDs)
                continue
            }
            let sourceValues = PlanTransactionValues(source)
            let corrections = try PlanValueField.allCases.filter {
                try !sameValue($0, sourceValues[$0], existing[$0])
            }
            let hasBasis = try DecimalJS.from(current.amount).gt(.zero)
            if transferWithoutBasis(row), !hasBasis || effectivePolicy != .preserveExisting {
                addBlocker(row, .missingOriginalBasis, candidateIDs)
                continue
            }
            let comparable = try equivalentEconomics(source, current, proof)
            var action = item.baseAction
            action.existingTransactionID = current.id
            action.existing = .transaction(existing, includedInUnits: false)
            action.corrections = corrections
            action.economicsProven = comparable
            guard let policy = effectivePolicy ?? (corrections.isEmpty ? .exact : nil) else {
                action.action = .policyRequired
                actions.append(action)
                addIssue(row, .sourcePolicyRequired, [current.id])
                continue
            }
            if effectivePolicy == .preferSource {
                if !comparable || source.kind != current.kind {
                    addBlocker(
                        row,
                        source.currency != current.currency ? .unprovenCurrencyConversion : .unprovenEconomics,
                        candidateIDs)
                    continue
                }
                if source.kind.map(unitKinds.contains) == true, try !equalNumber(source.units, current.units, 8),
                    try !proFeeExplainsUnits(proof, current)
                {
                    addBlocker(row, .unprovenUnits, candidateIDs)
                    continue
                }
            }
            var after = current
            after.accountID = row.accountID
            after.sourceRecordHash = row.sourceRecordHash
            after.dedupFingerprint = fingerprint
            after.dedupFingerprintVersion = fingerprintVersion
            // The staged source supplies each value column by name.
            if effectivePolicy == .preferSource {
                after.day = source.day ?? current.day
                after.amount = source.amount
                after.units = source.units
                after.pricePerUnit = source.pricePerUnit
                after.fees = source.fees
                after.taxes = source.taxes
                // A source without an exchange rate cannot erase a known rate for the same
                // currency. A currency correction requires proven conversion.
                if source.fxRateToEUR != nil || source.currency != current.currency {
                    after.fxRateToEUR = source.fxRateToEUR
                }
                after.currency = source.currency
                after.dividendAmountConvention = source.dividendAmountConvention
            }
            action.action = .adopt
            action.policy = policy
            actions.append(action)
            // Candidates share a staged transaction type, so they are never custody events:
            // both images are full portfolio transaction snapshots.
            adoptions.append(PlanAdoption(row: row, before: current, after: after, policy: policy))
        }
        return ReconciliationPlanResult(
            plan: ReconciliationPlan(
                batchIDs: batches.map(\.id), adoptPolicy: adoptPolicy, batchPolicies: canonicalPolicies,
                rowChoices: canonicalChoices, ready: blockers.isEmpty, actions: actions, blockers: blockers),
            adoptions: adoptions, settledDuplicates: settledDuplicates, cashAdoptions: cashAdoptions)
    }
}
