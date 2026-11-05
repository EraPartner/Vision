import Foundation

/// The bulk bar's calls, the Add transaction sheet's payee creation and transfer link
/// (apps/frontend/src/lib/api/transactions.ts and recipients.ts), so tests can use a fake.
public protocol TransactionBulkService: Sendable {
    /// `bulkUpdateTransactions({ ...selector, fields })`.
    func bulkUpdate(_ selector: BulkSelector, fields: BulkUpdateFields) async throws -> BulkUpdateResult
    /// `bulkDeleteTransactions(selector)`.
    func bulkDelete(_ selector: BulkSelector) async throws -> BulkDeleteResult
    /// `bulkExportTransactions({ ...selector, format })`: the file and `X-Exported-Count`.
    func bulkExport(_ selector: BulkSelector, format: ExportFormat) async throws -> BulkExportFile
    /// `bulkTagTransactions({ transaction_ids, add_slugs, remove_slugs })`.
    func bulkTag(ids: [TransactionID], add: [String], remove: [String]) async throws -> OpenAPI.BulkTagResult
    /// `markTransfer(aId, bId)`: `POST /api/transactions/transfers`.
    func markTransfer(_ first: TransactionID, _ second: TransactionID) async throws
    /// `createRecipient({ name })`: the existing payee when the name is taken.
    func createRecipient(name: String) async throws -> CreatedRecipient
}

/// `{ deleted, requested, matched }` of a bulk delete.
public typealias BulkDeleteResult = OpenAPIOperations.BulkDeleteTransactions.ResponseData

/// `POST /api/recipients`'s payee with `created` (`wasCreated`).
public typealias CreatedRecipient = OpenAPIOperations.CreateRecipient.ResponseData

/// A bulk export's file and the `X-Exported-Count` header, when the server sent one.
public struct BulkExportFile: Equatable, Sendable {
    public let data: Data
    public let exportedCount: Int?

    public init(data: Data, exportedCount: Int?) {
        self.data = data
        self.exportedCount = exportedCount
    }
}

extension APIClient: TransactionBulkService {
    public func bulkUpdate(_ selector: BulkSelector, fields: BulkUpdateFields) async throws -> BulkUpdateResult {
        try await send(TransactionBulkUpdateRequest(selector: selector, fields: fields))
    }

    public func bulkDelete(_ selector: BulkSelector) async throws -> BulkDeleteResult {
        try await send(TransactionBulkDeleteRequest(selector: selector))
    }

    public func bulkExport(_ selector: BulkSelector, format: ExportFormat) async throws -> BulkExportFile {
        let response = try await downloadResponse(TransactionBulkExportRequest(selector: selector, format: format))
        let count = response.headers["x-exported-count"].flatMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        return BulkExportFile(data: response.body, exportedCount: count.flatMap { $0 >= 0 ? $0 : nil })
    }

    public func bulkTag(ids: [TransactionID], add: [String], remove: [String]) async throws -> OpenAPI.BulkTagResult {
        try await send(
            OpenAPIOperations.BulkTagTransactions(
                body: OpenAPI.BulkTagRequest(transactionIds: ids, addSlugs: add, removeSlugs: remove)))
    }

    public func markTransfer(_ first: TransactionID, _ second: TransactionID) async throws {
        _ = try await send(OpenAPIOperations.MarkTransfer(body: .init(aId: first, bId: second)))
    }

    public func createRecipient(name: String) async throws -> CreatedRecipient {
        try await send(OpenAPIOperations.CreateRecipient(body: OpenAPI.RecipientCreate(name: name)))
    }
}

// MARK: - Selectors

/// `BulkTransactionFilter` as `TransactionsPage.currentFilter` builds it: the URL filters,
/// the settled search and Show excluded (`active: !showAll`). Absent values are left out.
public struct BulkFilterSelection: Equatable, Sendable {
    public var filters: TransactionFilters
    public var search: String
    public var active: Bool

    public init(filters: TransactionFilters, search: String, active: Bool) {
        self.filters = filters
        self.search = search
        self.active = active
    }

    enum Keys: String, CodingKey {
        case transactionId = "transaction_id"
        case recipientId = "recipient_id"
        case categoryId = "category_id"
        case categoryIds = "category_ids"
        case uncategorised
        case startDate = "start_date"
        case endDate = "end_date"
        case transactionType = "transaction_type"
        case amountMin = "amount_min"
        case amountMax = "amount_max"
        case amountSigned = "amount_signed"
        case tags
        case accountId = "account_id"
        case bankAccount = "bank_account"
        case search
        case active
    }

    func encode(into container: inout KeyedEncodingContainer<Keys>) throws {
        try container.encodeIfPresent(filters.transactionId, forKey: .transactionId)
        try container.encodeIfPresent(filters.recipientId, forKey: .recipientId)
        try container.encodeIfPresent(filters.categoryId, forKey: .categoryId)
        try container.encodeIfPresent(filters.categoryIds, forKey: .categoryIds)
        if filters.uncategorised { try container.encode(true, forKey: .uncategorised) }
        try container.encodeIfPresent(filters.startDate, forKey: .startDate)
        try container.encodeIfPresent(filters.endDate, forKey: .endDate)
        try container.encodeIfPresent(filters.transactionType?.rawValue, forKey: .transactionType)
        try container.encodeIfPresent(filters.amountMin, forKey: .amountMin)
        try container.encodeIfPresent(filters.amountMax, forKey: .amountMax)
        if filters.amountSigned { try container.encode(true, forKey: .amountSigned) }
        try container.encodeIfPresent(filters.tags, forKey: .tags)
        try container.encodeIfPresent(filters.accountId, forKey: .accountId)
        try container.encodeIfPresent(filters.bankAccount, forKey: .bankAccount)
        if !search.isEmpty { try container.encode(search, forKey: .search) }
        try container.encode(active, forKey: .active)
    }
}

/// `BulkSelectionRequest`: the checked ids, or the filter with the count the user saw
/// (`expected_count`) once "Select all matching" promoted the selection.
public enum BulkSelector: Equatable, Sendable {
    case ids([TransactionID])
    case filter(BulkFilterSelection, expectedCount: Int)

    /// How many rows the action names (`effectiveCount`).
    public var count: Int {
        switch self {
        case .ids(let ids): return ids.count
        case .filter(_, let expected): return expected
        }
    }
}

/// The body keys every bulk request shares.
enum BulkBodyKeys: String, CodingKey {
    case ids
    case filter
    case expectedCount = "expected_count"
    case fields
    case format
}

extension BulkSelector {
    func encode(into container: inout KeyedEncodingContainer<BulkBodyKeys>) throws {
        switch self {
        case .ids(let ids):
            try container.encode(ids, forKey: .ids)
        case .filter(let filter, let expected):
            var nested = container.nestedContainer(keyedBy: BulkFilterSelection.Keys.self, forKey: .filter)
            try filter.encode(into: &nested)
            try container.encode(expected, forKey: .expectedCount)
        }
    }
}

/// The `fields` of a bulk update: one change per action. `categoryId` `.some(nil)` sends
/// `null` (No category).
public struct BulkUpdateFields: Equatable, Sendable {
    public var categoryId: CategoryID??
    public var recipientId: RecipientID?
    public var isActive: Bool?

    public init(categoryId: CategoryID?? = nil, recipientId: RecipientID? = nil, isActive: Bool? = nil) {
        self.categoryId = categoryId
        self.recipientId = recipientId
        self.isActive = isActive
    }

    enum Keys: String, CodingKey {
        case categoryId = "category_id"
        case recipientId = "recipient_id"
        case isActive = "is_active"
    }

    func encode(into container: inout KeyedEncodingContainer<Keys>) throws {
        if let categoryId {
            if let categoryId {
                try container.encode(categoryId, forKey: .categoryId)
            } else {
                try container.encodeNil(forKey: .categoryId)
            }
        }
        try container.encodeIfPresent(recipientId, forKey: .recipientId)
        try container.encodeIfPresent(isActive, forKey: .isActive)
    }
}

/// The JSON of a bulk request: the selector and the action's own fields.
struct BulkRequestBody: Encodable {
    let selector: BulkSelector
    var fields: BulkUpdateFields?
    var format: ExportFormat?

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: BulkBodyKeys.self)
        try selector.encode(into: &container)
        if let fields {
            var nested = container.nestedContainer(keyedBy: BulkUpdateFields.Keys.self, forKey: .fields)
            try fields.encode(into: &nested)
        }
        if let format { try container.encode(format.rawValue, forKey: .format) }
    }
}

/// `POST /api/transactions/bulk-update` (operationId `bulkUpdateTransactions`) with a
/// selector: the generated body has no `ids` / `filter` (a `oneOf`).
public struct TransactionBulkUpdateRequest: APIOperation {
    public typealias Response = BulkUpdateResult
    public static let operationId = OpenAPIOperations.BulkUpdateTransactions.operationId
    public static let method = OpenAPIOperations.BulkUpdateTransactions.method
    public static let pathTemplate = OpenAPIOperations.BulkUpdateTransactions.pathTemplate

    public let selector: BulkSelector
    public let fields: BulkUpdateFields

    public init(selector: BulkSelector, fields: BulkUpdateFields) {
        self.selector = selector
        self.fields = fields
    }

    public var path: String { Self.pathTemplate }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(BulkRequestBody(selector: selector, fields: fields))
    }
}

/// `POST /api/transactions/bulk-delete` (operationId `bulkDeleteTransactions`).
public struct TransactionBulkDeleteRequest: APIOperation {
    public typealias Response = BulkDeleteResult
    public static let operationId = OpenAPIOperations.BulkDeleteTransactions.operationId
    public static let method = OpenAPIOperations.BulkDeleteTransactions.method
    public static let pathTemplate = OpenAPIOperations.BulkDeleteTransactions.pathTemplate

    public let selector: BulkSelector

    public init(selector: BulkSelector) {
        self.selector = selector
    }

    public var path: String { Self.pathTemplate }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(BulkRequestBody(selector: selector))
    }
}

/// `POST /api/transactions/bulk-export` (operationId `bulkExportTransactions`): a file, not
/// an envelope.
public struct TransactionBulkExportRequest: APIOperation {
    public typealias Response = APIEmpty
    public static let operationId = OpenAPIOperations.BulkExportTransactions.operationId
    public static let method = OpenAPIOperations.BulkExportTransactions.method
    public static let pathTemplate = OpenAPIOperations.BulkExportTransactions.pathTemplate

    public let selector: BulkSelector
    public let format: ExportFormat

    public init(selector: BulkSelector, format: ExportFormat) {
        self.selector = selector
        self.format = format
    }

    public var path: String { Self.pathTemplate }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(BulkRequestBody(selector: selector, format: format))
    }

    /// `transactions_export_<ISO stamp>.<csv|ndjson>` (`useBulkExportTransactions`).
    public static func fileName(_ format: ExportFormat, now: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: now)
        func pad(_ value: Int?, _ width: Int) -> String {
            let text = String(value ?? 0)
            return text.count >= width ? text : String(repeating: "0", count: width - text.count) + text
        }
        let stamp =
            "\(pad(parts.year, 4))-\(pad(parts.month, 2))-\(pad(parts.day, 2))T"
            + "\(pad(parts.hour, 2))-\(pad(parts.minute, 2))-\(pad(parts.second, 2))"
        return "transactions_export_\(stamp).\(format == .csv ? "csv" : "ndjson")"
    }
}
