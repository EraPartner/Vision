import Foundation

/// The split calls of the Split transaction dialog, the bulk Split and `/owes`
/// (apps/frontend/src/lib/api/splits.ts), so tests can use a fake.
public protocol SplitsService: Sendable {
    /// `getSplitsByTransaction(transactionId)`.
    func splits(transactionId: TransactionID) async throws -> [OpenAPI.Split]
    /// `createSplitsBatch(transactionId, splits)`.
    func createSplits(transactionId: TransactionID, shares: [SplitShare]) async throws
    /// `createBulkSplits({ transaction_ids, recipient_id, mode })`.
    func bulkSplit(transactionIds: [TransactionID], recipientId: RecipientID, mode: BulkSplitMode) async throws
        -> OpenAPI.BulkSplitResult
    /// `getOwedSummary(currency)`: the server converts the amounts to `currency` and totals the
    /// outstanding amount (`summary`, ADR-216).
    func owedSummary(currency: CurrencyCode) async throws -> OwedSummaryPage
    /// `getOwedByRecipient(recipientId, currency)`: the open splits and their server total.
    func owed(recipientId: RecipientID, currency: CurrencyCode) async throws -> OwedDetailPage
    /// `exportOwedByRecipientCsv(recipientId)`: the file's bytes.
    func exportOwedCsv(recipientId: RecipientID) async throws -> Data
    /// `recordSplitPayment(splitId, amount)`.
    func recordPayment(splitId: SplitID, amount: Decimal) async throws
    /// `settleSplit(splitId)`.
    func settle(splitId: SplitID) async throws
    /// `settleAllSplitsByRecipient(recipientId)`: `settled_count`.
    func settleAll(recipientId: RecipientID) async throws -> Int
    /// `deleteSplit(splitId)`.
    func deleteSplit(id: SplitID) async throws
    /// `getTransactions({ recipient_group_id, limit, offset, sort_by: "transaction_date",
    /// sort_dir: "desc" })`: the person detail's Recent transactions.
    func recipientTransactions(groupId: RecipientGroupID, offset: Int, limit: Int) async throws -> TransactionPage
}

/// `GET /api/splits/owed`: who owes what, and the total outstanding (`OwedTotals`).
public struct OwedSummaryPage: Equatable, Sendable {
    public let items: [OpenAPI.SplitOwed]
    public let summary: OpenAPI.OwedTotals

    public init(items: [OpenAPI.SplitOwed], summary: OpenAPI.OwedTotals) {
        self.items = items
        self.summary = summary
    }
}

/// `GET /api/splits/owed/{id}`: one person's open splits, and their total outstanding.
public struct OwedDetailPage: Equatable, Sendable {
    public let items: [OpenAPI.SplitOwedDetail]
    public let summary: OpenAPI.OwedTotals

    public init(items: [OpenAPI.SplitOwedDetail], summary: OpenAPI.OwedTotals) {
        self.items = items
        self.summary = summary
    }
}

/// One person's share the Split transaction dialog sends (`SplitCreateInput`).
public struct SplitShare: Equatable, Sendable {
    public let recipientId: RecipientID
    public let amount: Decimal
    /// `note || undefined`: `nil` leaves it out.
    public let note: String?

    public init(recipientId: RecipientID, amount: Decimal, note: String?) {
        self.recipientId = recipientId
        self.amount = amount
        self.note = note
    }
}

/// `BulkSplitMode`: `equal` is 50/50, `full` is 0/100 (the payee owes everything).
public enum BulkSplitMode: String, CaseIterable, Sendable {
    case equal
    case full

    /// `txPage.bulk.splitEqualHint` / `txPage.bulk.splitFullHint`.
    public var hintKey: String { self == .equal ? "txPage.bulk.splitEqualHint" : "txPage.bulk.splitFullHint" }

    /// `splitDialog.equalSplit` / `splitDialog.othersPayAll`.
    public var labelKey: String { self == .equal ? "splitDialog.equalSplit" : "splitDialog.othersPayAll" }
}

extension APIClient: SplitsService {
    public func splits(transactionId: TransactionID) async throws -> [OpenAPI.Split] {
        try await send(OpenAPIOperations.GetSplitsByTransaction(id: transactionId)).items
    }

    public func createSplits(transactionId: TransactionID, shares: [SplitShare]) async throws {
        let rows = shares.map { share in
            OpenAPIOperations.CreateSplitBatch.Body.SplitsItem(
                recipientId: share.recipientId, amount: share.amount, note: share.note)
        }
        _ = try await send(
            OpenAPIOperations.CreateSplitBatch(body: .init(transactionId: transactionId, splits: rows)))
    }

    public func bulkSplit(transactionIds: [TransactionID], recipientId: RecipientID, mode: BulkSplitMode) async throws
        -> OpenAPI.BulkSplitResult
    {
        try await send(
            OpenAPIOperations.CreateBulkSplits(
                body: .init(
                    transactionIds: transactionIds, recipientId: recipientId,
                    mode: OpenAPIOperations.CreateBulkSplits.Body.Mode(rawValue: mode.rawValue))))
    }

    public func owedSummary(currency: CurrencyCode) async throws -> OwedSummaryPage {
        let page = try await send(OpenAPIOperations.GetSplitsOwed(currency: currency))
        return OwedSummaryPage(items: page.items, summary: page.summary)
    }

    public func owed(recipientId: RecipientID, currency: CurrencyCode) async throws -> OwedDetailPage {
        let page = try await send(OpenAPIOperations.GetSplitOwedByRecipient(id: recipientId, currency: currency))
        return OwedDetailPage(items: page.items, summary: page.summary)
    }

    public func exportOwedCsv(recipientId: RecipientID) async throws -> Data {
        try await download(OpenAPIOperations.ExportSplitsOwedCsv(id: recipientId))
    }

    public func recordPayment(splitId: SplitID, amount: Decimal) async throws {
        _ = try await send(OpenAPIOperations.PaySplit(id: splitId, body: .init(amount: amount)))
    }

    public func settle(splitId: SplitID) async throws {
        _ = try await send(OpenAPIOperations.SettleSplit(id: splitId))
    }

    public func settleAll(recipientId: RecipientID) async throws -> Int {
        let answer = try await send(OpenAPIOperations.SettleAllSplitsForRecipient(id: recipientId))
        return answer.objectValue?["settled_count"].flatMap(Self.wholeNumber) ?? 0
    }

    public func deleteSplit(id: SplitID) async throws {
        _ = try await send(OpenAPIOperations.DeleteSplit(id: id))
    }

    public func recipientTransactions(groupId: RecipientGroupID, offset: Int, limit: Int) async throws -> TransactionPage {
        let list = try await send(
            OpenAPIOperations.GetTransactions(
                limit: limit, offset: offset, sortBy: "transaction_date", sortDir: "desc", recipientGroupId: groupId))
        return TransactionPage(items: list.items, total: list.total)
    }

    /// A JSON number as a whole count.
    static func wholeNumber(_ value: JSONValue) -> Int? {
        switch value {
        case .int(let number): return number
        case .double(let number): return number.isFinite ? Int(number) : nil
        default: return nil
        }
    }
}
