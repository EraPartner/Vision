import Foundation

/// The API calls of the Import & export page (apps/frontend/src/lib/api/imports.ts and
/// info.ts), so tests can use a fake.
public protocol ImportService: Sendable {
    /// `getSupportedParsers()`: the built-in bank adapters.
    func supportedAdapters() async throws -> [ImportAdapter]
    /// `listCustomParserConfigs()`.
    func customParsers() async throws -> [OpenAPI.CustomParserConfig]
    /// `createCustomParserConfig(name, config)`.
    func createCustomParser(name: String, config: CSVParserConfig) async throws -> OpenAPI.CustomParserConfig
    /// `updateCustomParserConfig(id, { name, config })`.
    func updateCustomParser(id: CustomParserConfigID, name: String, config: CSVParserConfig) async throws
        -> OpenAPI.CustomParserConfig
    /// `deleteCustomParserConfig(id)`.
    func deleteCustomParser(id: CustomParserConfigID) async throws
    /// `importCSVWithProgress(file, bankName, onProgress)`: the SSE import of a built-in bank.
    /// Each `progress` event (and the final `complete` or `review_required` panel) goes to
    /// `onProgress`. Cancelling the task aborts the stream.
    func importStream(
        file: ImportFile, bankName: String, onProgress: @escaping @Sendable (ImportProgress) async -> Void
    ) async throws -> ImportOutcome
    /// `importCSVCustom(...)`: one multipart request with the custom setup.
    func importCustom(file: ImportFile, bankName: String, config: CSVParserConfig) async throws -> ImportOutcome
    /// `listImportBatches(limit, offset)`.
    func importBatches(limit: Int, offset: Int) async throws -> ImportBatchPage
    /// `rollbackImportBatch(id)`: the number of transactions deleted.
    func rollbackImportBatch(id: ImportBatchID) async throws -> Int
}

/// One page of `GET /api/import/batches`.
public typealias ImportBatchPage = OpenAPIOperations.GetImportBatches.ResponseData

extension APIClient: ImportService {
    public func supportedAdapters() async throws -> [ImportAdapter] {
        try await send(OpenAPIOperations.GetSupportedAdapters()).items
    }

    public func customParsers() async throws -> [OpenAPI.CustomParserConfig] {
        try await send(OpenAPIOperations.GetCustomParsers()).items
    }

    public func createCustomParser(name: String, config: CSVParserConfig) async throws -> OpenAPI.CustomParserConfig {
        try await send(OpenAPIOperations.CreateCustomParser(body: .init(name: name, config: config.payload)))
    }

    public func updateCustomParser(id: CustomParserConfigID, name: String, config: CSVParserConfig) async throws
        -> OpenAPI.CustomParserConfig
    {
        try await send(OpenAPIOperations.UpdateCustomParser(id: id, body: .init(name: name, config: config.payload)))
    }

    public func deleteCustomParser(id: CustomParserConfigID) async throws {
        _ = try await send(OpenAPIOperations.DeleteCustomParser(id: id))
    }

    public func importStream(
        file: ImportFile, bankName: String, onProgress: @escaping @Sendable (ImportProgress) async -> Void
    ) async throws -> ImportOutcome {
        var form = MultipartFormData()
        form.append(file: "file", filename: file.name, contentType: file.uploadType, data: file.data)
        form.append("bank_name", bankName)
        var outcome: ImportOutcome?
        try await streamEvents(path: ImportStreamEvents.path, body: form, fallbackMessage: "Import failed") { event in
            if let next = try ImportStreamEvents.handle(event) {
                switch next {
                case .progress(let progress):
                    await onProgress(progress)
                case .finished(let result, let panel):
                    outcome = result
                    await onProgress(panel)
                }
            }
        }
        return outcome ?? .completed(ImportCompletion(total: 0, imported: 0, duplicates: 0, errors: 0))
    }

    public func importCustom(file: ImportFile, bankName: String, config: CSVParserConfig) async throws
        -> ImportOutcome
    {
        try await send(ImportCsvCustomRequest(file: file, bankName: bankName, config: config)).outcome
    }

    public func importBatches(limit: Int, offset: Int) async throws -> ImportBatchPage {
        try await send(OpenAPIOperations.GetImportBatches(limit: limit, offset: offset))
    }

    public func rollbackImportBatch(id: ImportBatchID) async throws -> Int {
        try await send(OpenAPIOperations.DeleteImportBatch(id: id)).deleted
    }
}

extension ImportFile {
    /// The part's type, as the browser sends a `File`: its own type, else a generic one.
    var uploadType: String { mimeType ?? "application/octet-stream" }
}

/// The events of `POST /api/import/csv/stream` (`IMPORT_STREAM_SCHEMAS` and the loop of
/// `importCSVWithProgress`).
public enum ImportStreamEvents {
    public static let path = "/api/import/csv/stream"

    public enum Step: Equatable, Sendable {
        case progress(ImportProgress)
        /// The terminal event: the result and the panel it leaves.
        case finished(ImportOutcome, ImportProgress)
    }

    /// One event: `progress`, `complete` and `review_required` are checked against their
    /// shape (a mismatch fails the stream like malformed JSON), `error` fails it with its
    /// detail, and any other event (or `[DONE]`) is skipped.
    public static func handle(_ event: ServerSentEvent) throws -> Step? {
        guard event.data != "[DONE]" else { return nil }
        let payload: JSONValue
        do {
            payload = try JSONValue.parse(Data(event.data.utf8))
        } catch {
            throw ImportStreamFailure(detail: "Invalid SSE payload")
        }
        switch event.event {
        case "progress":
            return .progress(try decode(ImportProgress.self, from: payload, event: event.event))
        case "complete":
            let result = try decode(CompleteEvent.self, from: payload, event: event.event)
            let completion = ImportCompletion(
                total: result.totalProcessed, imported: result.imported, duplicates: result.duplicates,
                errors: result.errors, batchId: result.batchId)
            // `{ ...data, phase: "complete", percent: 100 }`: the event has no row position.
            let panel = ImportProgress(
                phase: "complete", imported: result.imported, duplicates: result.duplicates, errors: result.errors,
                percent: 100)
            if result.requiresReview == true, let batchId = result.batchId {
                return .finished(.reviewRequired(batchId: batchId), panel)
            }
            return .finished(.completed(completion), panel)
        case "review_required":
            let result = try decode(ReviewRequiredEvent.self, from: payload, event: event.event)
            return .finished(.reviewRequired(batchId: result.batchId), ImportProgress(phase: "review_required", percent: 100))
        case "error":
            throw ImportStreamFailure(detail: detail(payload))
        default:
            return nil
        }
    }

    /// `extractErrorDetail`: a non-blank string `detail`, else "Import failed".
    static func detail(_ payload: JSONValue) -> String {
        if let detail = payload["detail"]?.stringValue, !detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return detail
        }
        return "Import failed"
    }

    static func decode<Value: Decodable>(_ type: Value.Type, from payload: JSONValue, event: String) throws -> Value {
        do {
            return try payload.decode(Value.self)
        } catch {
            throw ImportStreamFailure(detail: "Invalid SSE payload for \"\(event)\" event")
        }
    }

    /// `importResultSchema`.
    struct CompleteEvent: Decodable {
        let totalProcessed: Int
        let imported: Int
        let duplicates: Int
        let errors: Int
        let batchId: Int?
        let requiresReview: Bool?

        enum CodingKeys: String, CodingKey {
            case totalProcessed = "total_processed"
            case imported, duplicates, errors
            case batchId = "batch_id"
            case requiresReview = "requires_review"
        }
    }

    /// `reviewRequiredSchema`: only `batch_id` is read.
    struct ReviewRequiredEvent: Decodable {
        let batchId: Int

        enum CodingKeys: String, CodingKey {
            case batchId = "batch_id"
        }
    }
}

/// `POST /api/import/csv/custom` (operationId `importCsvCustom`): the file and the custom
/// setup as flat multipart fields, which the generator (JSON bodies only) cannot write.
public struct ImportCsvCustomRequest: APIOperation {
    public typealias Response = ImportCsvResponse
    public static let operationId = "importCsvCustom"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/import/csv/custom"

    public let form: MultipartFormData

    /// The fields of `importCSVCustom`, in its order; the memo column only when mapped.
    public init(file: ImportFile, bankName: String, config: CSVParserConfig, boundary: String? = nil) {
        var form = boundary.map { MultipartFormData(boundary: $0) } ?? MultipartFormData()
        form.append(file: "file", filename: file.name, contentType: file.uploadType, data: file.data)
        form.append("bank_name", bankName)
        form.append("date_format", config.dateFormat)
        form.append("date_column", config.dateColumn)
        form.append("recipient_column", config.recipientColumn)
        form.append("amount_column", config.amountColumn)
        if !config.memoColumn.isEmpty { form.append("memo_column", config.memoColumn) }
        form.append("separator", config.separator)
        form.append("encoding", config.encoding)
        form.append("skip_rows", String(config.skipRows))
        form.append("number_format", config.numberFormat.rawValue)
        self.form = form
    }

    public var path: String { Self.pathTemplate }
    public var contentType: String { form.contentType }

    public func encodedBody() throws -> Data? {
        form.encoded()
    }
}

/// The two bodies of the custom import: `201` with the committed counts
/// (`ImportCsvResult`), or `202` when rows need review (`ImportCsvReviewRequired`), told
/// apart by `requires_review` (`isReviewRequired`).
public struct ImportCsvResponse: Decodable, Equatable, Sendable {
    public let outcome: ImportOutcome

    enum CodingKeys: String, CodingKey {
        case requiresReview = "requires_review"
        case batchId = "batch_id"
        case total, imported, duplicates, errors
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.requiresReview) {
            _ = try container.decode(Bool.self, forKey: .requiresReview)
            outcome = .reviewRequired(batchId: try container.decode(Int.self, forKey: .batchId))
            return
        }
        outcome = .completed(
            ImportCompletion(
                total: try container.decode(Int.self, forKey: .total),
                imported: try container.decode(Int.self, forKey: .imported),
                duplicates: try container.decode(Int.self, forKey: .duplicates),
                errors: try container.decode(Int.self, forKey: .errors),
                batchId: try container.decodeIfPresent(Int.self, forKey: .batchId)))
    }
}
