import Foundation

/// The API calls of `/transactions` (apps/frontend/src/lib/api/transactions.ts,
/// attachments.ts, recipients.ts and the settings the page reads), so tests can use a fake.
public protocol TransactionsService: Sendable {
    /// `getTransactions({ limit, offset, …filters, include_balance: true })`: one page.
    func transactionPage(_ query: TransactionListQuery, offset: Int) async throws -> TransactionPage
    /// `getTransactions({ uncategorised: true, active: true, limit: 1, recipient_id? })`: the
    /// `total` the Needs category chip and the inspector's tip show.
    func uncategorisedCount(recipientId: RecipientID?) async throws -> Int
    /// `updateTransaction(id, data)` with explicit nulls.
    func updateTransaction(id: TransactionID, patch: TransactionPatch) async throws -> OpenAPI.Transaction
    /// `createTransaction(data)`: Duplicate and the delete Undo.
    func createTransaction(_ body: OpenAPI.TransactionCreate) async throws -> OpenAPI.Transaction
    /// `deleteTransaction(id)`.
    func deleteTransaction(id: TransactionID) async throws
    /// `bulkUpdateTransactions({ filter: { recipient_id, uncategorised, active }, expected_count,
    /// fields: { category_id } })`: the inspector's Use for all.
    func categorizeUncategorised(recipientId: RecipientID, categoryId: CategoryID, expectedCount: Int) async throws
        -> BulkUpdateResult
    /// `updateRecipient(id, { default_category_id })`: Always use.
    func setRecipientDefaultCategory(recipientId: RecipientID, categoryId: CategoryID) async throws
    /// `getRecipient(id)`: the banner's payee name and the inspector's rule tips.
    func recipient(id: RecipientID) async throws -> OpenAPI.Recipient
    /// `useAccounts({ active: "all" })`: the Account filter lists archived accounts too.
    func allAccounts() async throws -> [OpenAPI.Account]
    /// `requestBlob("/api/transactions/export/{csv|json}?…")`.
    func exportFilteredTransactions(_ format: ExportFormat, query: TransactionExportQuery) async throws -> Data
    /// `getSetting(key)`.
    func setting(key: SettingKey) async throws -> OpenAPI.Setting
    /// `saveSetting(key, value)` against the baseline of the last read.
    func saveSetting(key: SettingKey, value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting
}

/// The Attachments panel's calls (apps/frontend/src/lib/api/attachments.ts).
public protocol TransactionAttachmentsService: Sendable {
    /// `getAttachments(transactionId)`.
    func attachments(transactionId: TransactionID) async throws -> [OpenAPI.Attachment]
    /// `uploadAttachment(transactionId, file)`: one multipart `file` part.
    func uploadAttachment(transactionId: TransactionID, file: AttachmentUpload) async throws -> OpenAPI.Attachment
    /// `GET /api/attachments/:id/download`: the file's bytes.
    func downloadAttachment(id: AttachmentID) async throws -> Data
    /// `deleteAttachment(id)`.
    func deleteAttachment(id: AttachmentID) async throws
}

/// One page of `GET /api/transactions`.
public struct TransactionPage: Equatable, Sendable {
    public let items: [OpenAPI.Transaction]
    public let total: Int

    public init(items: [OpenAPI.Transaction], total: Int) {
        self.items = items
        self.total = total
    }
}

/// `{ updated, requested, matched }` of a bulk update.
public typealias BulkUpdateResult = OpenAPIOperations.BulkUpdateTransactions.ResponseData

extension APIClient: TransactionsService {
    public func transactionPage(_ query: TransactionListQuery, offset: Int) async throws -> TransactionPage {
        let list = try await send(query.operation(offset: offset))
        return TransactionPage(items: list.items, total: list.total)
    }

    public func uncategorisedCount(recipientId: RecipientID?) async throws -> Int {
        try await send(
            OpenAPIOperations.GetTransactions(limit: 1, recipientId: recipientId, active: true, uncategorised: true)
        ).total
    }

    public func updateTransaction(id: TransactionID, patch: TransactionPatch) async throws -> OpenAPI.Transaction {
        try await send(TransactionPatchRequest(id: id, patch: patch))
    }

    public func createTransaction(_ body: OpenAPI.TransactionCreate) async throws -> OpenAPI.Transaction {
        try await send(OpenAPIOperations.CreateTransaction(body: body))
    }

    public func deleteTransaction(id: TransactionID) async throws {
        _ = try await send(OpenAPIOperations.DeleteTransaction(id: id))
    }

    public func categorizeUncategorised(recipientId: RecipientID, categoryId: CategoryID, expectedCount: Int) async throws
        -> BulkUpdateResult
    {
        try await send(
            TransactionBulkCategoryRequest(recipientId: recipientId, categoryId: categoryId, expectedCount: expectedCount))
    }

    public func exportFilteredTransactions(_ format: ExportFormat, query: TransactionExportQuery) async throws -> Data {
        switch format {
        case .csv: return try await download(query.csv)
        case .json: return try await download(query.json)
        }
    }
}

extension APIClient: TransactionAttachmentsService {
    public func attachments(transactionId: TransactionID) async throws -> [OpenAPI.Attachment] {
        try await send(OpenAPIOperations.GetTransactionAttachments(id: transactionId)).items
    }

    public func uploadAttachment(transactionId: TransactionID, file: AttachmentUpload) async throws -> OpenAPI.Attachment {
        try await send(AttachmentUploadRequest(transactionId: transactionId, file: file))
    }

    public func downloadAttachment(id: AttachmentID) async throws -> Data {
        try await download(OpenAPIOperations.DownloadAttachment(id: id), fallbackMessage: "Download failed")
    }

    public func deleteAttachment(id: AttachmentID) async throws {
        _ = try await send(OpenAPIOperations.DeleteAttachment(id: id))
    }
}

// MARK: - Hand-written requests

/// `TransactionUpdate` as the page sends it: an absent field is left alone, and the
/// nullable fields can carry an explicit `null` (clear), which the generated body drops.
public struct TransactionPatch: Equatable, Sendable, Encodable {
    public var transactionDate: String?
    /// `.some(nil)` sends `null` (no account).
    public var accountId: AccountID??
    /// `.some(nil)` sends `null` (No payee).
    public var recipientId: RecipientID??
    /// `.some(nil)` sends `null` (a cleared description).
    public var memo: String??
    public var amount: Decimal?
    public var currency: CurrencyCode?
    /// `.some(nil)` sends `null` (No category).
    public var categoryId: CategoryID??
    /// `.some(nil)` sends `null` (a cleared comment).
    public var comment: String??
    public var isActive: Bool?
    public var tags: [String]?

    public init() {}

    enum CodingKeys: String, CodingKey {
        case transactionDate = "transaction_date"
        case accountId = "account_id"
        case recipientId = "recipient_id"
        case memo
        case amount
        case currency
        case categoryId = "category_id"
        case comment
        case isActive = "is_active"
        case tags
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(transactionDate, forKey: .transactionDate)
        try Self.encode(accountId, forKey: .accountId, in: &container)
        try Self.encode(recipientId, forKey: .recipientId, in: &container)
        try Self.encode(memo, forKey: .memo, in: &container)
        try container.encodeIfPresent(amount, forKey: .amount)
        try container.encodeIfPresent(currency, forKey: .currency)
        try Self.encode(categoryId, forKey: .categoryId, in: &container)
        try Self.encode(comment, forKey: .comment, in: &container)
        try container.encodeIfPresent(isActive, forKey: .isActive)
        try container.encodeIfPresent(tags, forKey: .tags)
    }

    /// Absent: nothing; `.some(nil)`: `null`; a value: the value.
    private static func encode<Value: Encodable>(
        _ value: Value??, forKey key: CodingKeys, in container: inout KeyedEncodingContainer<CodingKeys>
    ) throws {
        guard let value else { return }
        if let value {
            try container.encode(value, forKey: key)
        } else {
            try container.encodeNil(forKey: key)
        }
    }
}

/// `PATCH /api/transactions/{id}` (operationId `updateTransaction`) with `TransactionPatch`.
public struct TransactionPatchRequest: APIOperation {
    public typealias Response = OpenAPI.Transaction
    public static let operationId = OpenAPIOperations.UpdateTransaction.operationId
    public static let method = OpenAPIOperations.UpdateTransaction.method
    public static let pathTemplate = OpenAPIOperations.UpdateTransaction.pathTemplate

    public var id: TransactionID
    public var patch: TransactionPatch

    public init(id: TransactionID, patch: TransactionPatch) {
        self.id = id
        self.patch = patch
    }

    public var path: String { OpenAPIOperations.UpdateTransaction(id: id, body: OpenAPI.TransactionUpdate()).path }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(patch)
    }
}

/// `POST /api/transactions/bulk-update` (operationId `bulkUpdateTransactions`) in filter mode:
/// the generated body has no selector, so this one carries the filter and its
/// `expected_count`. `category_id` is the only field Use for all sends.
public struct TransactionBulkCategoryRequest: APIOperation {
    public typealias Response = BulkUpdateResult
    public static let operationId = OpenAPIOperations.BulkUpdateTransactions.operationId
    public static let method = OpenAPIOperations.BulkUpdateTransactions.method
    public static let pathTemplate = OpenAPIOperations.BulkUpdateTransactions.pathTemplate

    public let recipientId: RecipientID
    public let categoryId: CategoryID
    public let expectedCount: Int

    public init(recipientId: RecipientID, categoryId: CategoryID, expectedCount: Int) {
        self.recipientId = recipientId
        self.categoryId = categoryId
        self.expectedCount = expectedCount
    }

    public var path: String { Self.pathTemplate }

    struct Body: Encodable {
        struct Filter: Encodable {
            let recipientId: RecipientID
            let uncategorised = true
            let active = true

            enum CodingKeys: String, CodingKey {
                case recipientId = "recipient_id"
                case uncategorised
                case active
            }
        }

        struct Fields: Encodable {
            let categoryId: CategoryID

            enum CodingKeys: String, CodingKey {
                case categoryId = "category_id"
            }
        }

        let filter: Filter
        let expectedCount: Int
        let fields: Fields

        enum CodingKeys: String, CodingKey {
            case filter
            case expectedCount = "expected_count"
            case fields
        }
    }

    public func encodedBody() throws -> Data? {
        try APIBody.encode(
            Body(
                filter: Body.Filter(recipientId: recipientId), expectedCount: expectedCount,
                fields: Body.Fields(categoryId: categoryId)))
    }
}

/// A file the Attachments panel uploads (`<input type="file" accept="image/*,application/pdf">`).
public struct AttachmentUpload: Equatable, Sendable {
    public let name: String
    public let contentType: String
    public let data: Data

    public init(name: String, contentType: String, data: Data) {
        self.name = name
        self.contentType = contentType
        self.data = data
    }
}

/// `POST /api/attachments/transaction/{id}` (operationId `uploadAttachment`): one multipart
/// `file` part, which the generator cannot write.
public struct AttachmentUploadRequest: APIOperation {
    public typealias Response = OpenAPI.Attachment
    public static let operationId = "uploadAttachment"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/attachments/transaction/{id}"

    public let transactionId: TransactionID
    public let form: MultipartFormData

    public init(transactionId: TransactionID, file: AttachmentUpload, boundary: String? = nil) {
        self.transactionId = transactionId
        var form = boundary.map { MultipartFormData(boundary: $0) } ?? MultipartFormData()
        form.append(file: "file", filename: file.name, contentType: file.contentType, data: file.data)
        self.form = form
    }

    public var path: String { OpenAPIOperations.GetTransactionAttachments(id: transactionId).path }
    public var contentType: String { form.contentType }

    public func encodedBody() throws -> Data? {
        form.encoded()
    }
}
