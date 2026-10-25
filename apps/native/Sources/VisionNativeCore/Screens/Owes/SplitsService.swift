import Foundation

/// The split calls of the Split transaction dialog, the bulk Split and `/owes`
/// (apps/frontend/src/lib/api/splits.ts), so tests can use a fake.
public protocol SplitsService: Sendable {
    /// `getSplitsByTransaction(transactionId)`.
    func splits(transactionId: Int) async throws -> [OpenAPI.Split]
    /// `createSplitsBatch(transactionId, splits)`.
    func createSplits(transactionId: Int, shares: [SplitShare]) async throws
    /// `createBulkSplits({ transaction_ids, recipient_id, mode })`.
    func bulkSplit(transactionIds: [Int], recipientId: Int, mode: BulkSplitMode) async throws
        -> OpenAPI.BulkSplitResult
    /// `getOwedSummary(currency)`: the server converts the amounts to `currency`.
    func owedSummary(currency: String) async throws -> [OpenAPI.SplitOwed]
    /// `getOwedByRecipient(recipientId, currency)`.
    func owed(recipientId: Int, currency: String) async throws -> [OpenAPI.SplitOwedDetail]
    /// `exportOwedByRecipientCsv(recipientId)`: the file's bytes.
    func exportOwedCsv(recipientId: Int) async throws -> Data
    /// `recordSplitPayment(splitId, amount)`.
    func recordPayment(splitId: Int, amount: Decimal) async throws
    /// `settleSplit(splitId)`.
    func settle(splitId: Int) async throws
    /// `settleAllSplitsByRecipient(recipientId)`: `settled_count`.
    func settleAll(recipientId: Int) async throws -> Int
    /// `deleteSplit(splitId)`.
    func deleteSplit(id: Int) async throws
    /// `getTransactions({ recipient_group_id, limit, offset, sort_by: "transaction_date",
    /// sort_dir: "desc" })`: the person detail's Recent transactions.
    func recipientTransactions(groupId: Int, offset: Int, limit: Int) async throws -> TransactionPage
}

/// One person's share the Split transaction dialog sends (`SplitCreateInput`).
public struct SplitShare: Equatable, Sendable {
    public let recipientId: Int
    public let amount: Decimal
    /// `note || undefined`: `nil` leaves it out.
    public let note: String?

    public init(recipientId: Int, amount: Decimal, note: String?) {
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
    public func splits(transactionId: Int) async throws -> [OpenAPI.Split] {
        try await send(OpenAPIOperations.GetSplitsByTransaction(id: transactionId)).items
    }

    public func createSplits(transactionId: Int, shares: [SplitShare]) async throws {
        let rows = shares.map { share in
            OpenAPIOperations.CreateSplitBatch.Body.SplitsItem(
                recipientId: share.recipientId, amount: share.amount, note: share.note)
        }
        _ = try await send(
            OpenAPIOperations.CreateSplitBatch(body: .init(transactionId: transactionId, splits: rows)))
    }

    public func bulkSplit(transactionIds: [Int], recipientId: Int, mode: BulkSplitMode) async throws
        -> OpenAPI.BulkSplitResult
    {
        try await send(
            OpenAPIOperations.CreateBulkSplits(
                body: .init(transactionIds: transactionIds, recipientId: recipientId, mode: mode.rawValue)))
    }

    public func owedSummary(currency: String) async throws -> [OpenAPI.SplitOwed] {
        try await send(OpenAPIOperations.GetSplitsOwed(currency: currency)).items
    }

    public func owed(recipientId: Int, currency: String) async throws -> [OpenAPI.SplitOwedDetail] {
        try await send(OpenAPIOperations.GetSplitOwedByRecipient(id: recipientId, currency: currency)).items
    }

    public func exportOwedCsv(recipientId: Int) async throws -> Data {
        try await download(OpenAPIOperations.ExportSplitsOwedCsv(id: recipientId))
    }

    public func recordPayment(splitId: Int, amount: Decimal) async throws {
        _ = try await send(OpenAPIOperations.PaySplit(id: splitId, body: .init(amount: amount)))
    }

    public func settle(splitId: Int) async throws {
        _ = try await send(OpenAPIOperations.SettleSplit(id: splitId))
    }

    public func settleAll(recipientId: Int) async throws -> Int {
        let answer = try await send(OpenAPIOperations.SettleAllSplitsForRecipient(id: recipientId))
        return answer.objectValue?["settled_count"].flatMap(Self.wholeNumber) ?? 0
    }

    public func deleteSplit(id: Int) async throws {
        _ = try await send(OpenAPIOperations.DeleteSplit(id: id))
    }

    public func recipientTransactions(groupId: Int, offset: Int, limit: Int) async throws -> TransactionPage {
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
