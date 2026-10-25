import Foundation

public protocol PortfolioImportService: Sendable {
    func importProbe(file: PortfolioImportFile, config: PortfolioImportConfig) async throws -> PortfolioImportProbe
    func importParsers() async throws -> [PortfolioImportParser]
    func importSaveParser(id: Int?, name: String, config: PortfolioImportConfig) async throws -> PortfolioImportParser
    func importDeleteParser(id: Int) async throws
    func importAccounts() async throws -> [OpenAPI.Account]
    func importInvestments() async throws -> [PortfolioInvestment]
    func importStream(
        file: PortfolioImportFile, config: PortfolioImportConfig, adapterName: String,
        onProgress: @escaping @Sendable (ImportProgress) async -> Void
    ) async throws -> PortfolioImportOutcome
    func importBatches(limit: Int, offset: Int) async throws -> PortfolioImportBatchPage
    func importPreview(batchId: Int) async throws -> PortfolioImportPreview
    func importOverride(batchId: Int, rowIds: [String], investmentId: Int?, createNew: Bool) async throws
    func importCommit(batchId: Int, accountId: Int?) async throws -> PortfolioImportCommitResult
    func importRollback(batchId: Int) async throws -> Int
    func importReconciliationPreview(scope: PortfolioImportReconciliationScope) async throws
        -> PortfolioImportReconciliationPlan
    func importReconciliationCommit(scope: PortfolioImportReconciliationScope) async throws
        -> PortfolioImportReconciliationResult
}

extension APIClient: PortfolioImportService {
    public func importProbe(file: PortfolioImportFile, config: PortfolioImportConfig) async throws
        -> PortfolioImportProbe
    {
        try await send(PortfolioImportProbeRequest(file: file, config: config))
    }
    public func importParsers() async throws -> [PortfolioImportParser] {
        let page: PortfolioPage<PortfolioImportParser> = try await send(
            InsightRequest(OpenAPIOperations.GetPortfolioParsers(), query: []))
        return page.items
    }
    public func importSaveParser(id: Int?, name: String, config: PortfolioImportConfig) async throws
        -> PortfolioImportParser
    {
        let body = try JSONEncoder().encode(TaxValue.object(["name": .string(name), "config": config.payload]))
        if let id {
            return try await send(
                InsightRequest(
                    OpenAPIOperations.UpdatePortfolioParser(id: id, body: .init()), query: [], bodyOverride: body))
        }
        return try await send(
            InsightRequest(
                OpenAPIOperations.CreatePortfolioParser(body: .init(name: name, config: .init())), query: [],
                bodyOverride: body))
    }
    public func importDeleteParser(id: Int) async throws {
        _ = try await send(OpenAPIOperations.DeletePortfolioParser(id: id))
    }
    public func importAccounts() async throws -> [OpenAPI.Account] {
        try await send(OpenAPIOperations.GetAccounts(active: "true")).items
    }
    public func importInvestments() async throws -> [PortfolioInvestment] {
        var rows: [PortfolioInvestment] = []
        var total: Int?
        while total == nil || rows.count < total! {
            let page: PortfolioPage<PortfolioInvestment> = try await send(
                InsightRequest(
                    OpenAPIOperations.GetInvestments(active: true, limit: 500, offset: rows.count),
                    query: [
                        .init(name: "active", value: "true"), .init(name: "limit", value: "500"),
                        .init(name: "offset", value: String(rows.count)),
                    ]))
            guard page.total >= 0, total == nil || total == page.total, page.offset == nil || page.offset == rows.count,
                rows.count + page.items.count <= page.total, !page.items.isEmpty || rows.count == page.total,
                page.items.allSatisfy(\.isActive),
                Set((rows + page.items).map(\.id)).count == rows.count + page.items.count
            else { throw PortfolioImportFailure.unverified("Unverified investment picker source") }
            total = page.total
            rows += page.items
        }
        return rows
    }
    public func importStream(
        file: PortfolioImportFile, config: PortfolioImportConfig, adapterName: String,
        onProgress: @escaping @Sendable (ImportProgress) async -> Void
    ) async throws -> PortfolioImportOutcome {
        let form = try PortfolioImportUploadRequest.form(file: file, config: config, adapterName: adapterName)
        var outcome: PortfolioImportOutcome?
        try await streamEvents(path: "/api/portfolio/import/csv/stream", body: form, fallbackMessage: "Import failed") {
            event in
            if let next = try PortfolioImportStreamEvents.handle(event) {
                switch next {
                case .progress(let progress): await onProgress(progress)
                case .finished(let result, let progress):
                    guard outcome == nil else {
                        throw PortfolioImportFailure.unverified("Multiple portfolio import terminal events")
                    }
                    outcome = result
                    await onProgress(progress)
                }
            }
        }
        guard let outcome else {
            throw PortfolioImportFailure.ambiguous(
                "Portfolio import ended without a verified result; refresh retained batches before retrying")
        }
        return outcome
    }
    public func importBatches(limit: Int, offset: Int) async throws -> PortfolioImportBatchPage {
        let page: PortfolioImportBatchPage = try await send(
            InsightRequest(
                OpenAPIOperations.GetPortfolioImportBatches(limit: limit, offset: offset),
                query: [.init(name: "limit", value: String(limit)), .init(name: "offset", value: String(offset))]))
        try page.validate(limit: limit, offset: offset)
        return page
    }
    public func importPreview(batchId: Int) async throws -> PortfolioImportPreview {
        let preview: PortfolioImportPreview = try await send(
            InsightRequest(OpenAPIOperations.PreviewPortfolioImportBatch(id: batchId), query: []))
        try preview.validate(batchId: batchId)
        return preview
    }
    public func importOverride(batchId: Int, rowIds: [String], investmentId: Int?, createNew: Bool) async throws {
        guard !rowIds.isEmpty, Set(rowIds).count == rowIds.count,
            rowIds.allSatisfy({ $0.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil }),
            createNew || (investmentId ?? 0) > 0
        else { throw PortfolioImportFailure.unverified("Invalid investment resolution request") }
        var body: TaxValue = .object(["row_ids": .array(rowIds.map(TaxValue.string))])
        if createNew {
            body["create_new"] = .bool(true)
        } else {
            body["investment_id"] = .number(Decimal(investmentId!))
        }
        let result: TaxValue = try await send(
            InsightRequest(
                OpenAPIOperations.PortfolioImportRowsInvestmentOverride(id: batchId, body: .null), query: [],
                bodyOverride: try JSONEncoder().encode(body)))
        guard let resolved = result["resolved"]?.importIntValue, resolved == rowIds.count,
            let returned = result["investment_id"]?.importIntValue, returned > 0,
            result["created"]?.boolValue == createNew, createNew || returned == investmentId
        else { throw PortfolioImportFailure.unverified("Unverified investment resolution response") }
        if createNew {
            _ =
                try result["investment"]?.decode(PortfolioInvestment.self)
                ?? { throw PortfolioImportFailure.unverified("Missing created investment") }()
        }
    }
    public func importCommit(batchId: Int, accountId: Int?) async throws -> PortfolioImportCommitResult {
        let result: PortfolioImportCommitResult = try await send(
            InsightRequest(
                OpenAPIOperations.CommitPortfolioImportBatch(id: batchId, body: .init(accountId: accountId)), query: [])
        )
        guard result.batchId == batchId,
            [result.total, result.imported, result.duplicates, result.errors].allSatisfy({ $0 >= 0 })
        else { throw PortfolioImportFailure.unverified("Unverified portfolio commit response") }
        return result
    }
    public func importRollback(batchId: Int) async throws -> Int {
        let result: TaxValue = try await send(
            InsightRequest(OpenAPIOperations.DeletePortfolioImportBatch(id: batchId), query: []))
        guard let deleted = result["deleted"]?.importIntValue else {
            throw PortfolioImportFailure.unverified("Unverified portfolio rollback response")
        }
        return deleted
    }
    public func importReconciliationPreview(scope: PortfolioImportReconciliationScope) async throws
        -> PortfolioImportReconciliationPlan
    {
        let result: PortfolioImportReconciliationPlan = try await send(
            InsightRequest(OpenAPIOperations.PreviewPortfolioImportReconciliation(body: try scope.request()), query: []))
        try result.validate(scope: scope)
        return result
    }
    public func importReconciliationCommit(scope: PortfolioImportReconciliationScope) async throws
        -> PortfolioImportReconciliationResult
    {
        let result: PortfolioImportReconciliationResult = try await send(
            InsightRequest(OpenAPIOperations.CommitReviewedPortfolioImports(body: try scope.request()), query: []))
        try result.validate(scope: scope)
        return result
    }
}

public struct PortfolioImportProbeRequest: APIOperation {
    public typealias Response = PortfolioImportProbe
    public static let operationId = "probePortfolioImport"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/portfolio/import/probe"
    public let form: MultipartFormData
    public init(file: PortfolioImportFile, config: PortfolioImportConfig) {
        var form = MultipartFormData()
        form.append(file: "file", filename: file.filename, contentType: file.contentType, data: file.data)
        form.append("separator", config.separator)
        form.append(
            "encoding", ["latin-1", "iso-8859-1"].contains(config.encoding.lowercased()) ? "latin1" : config.encoding)
        form.append("skipRows", String(config.skipRows))
        self.form = form
    }
    public var path: String { Self.pathTemplate }
    public var contentType: String { form.contentType }
    public func encodedBody() throws -> Data? { form.encoded() }
}

public struct PortfolioImportUploadRequest: APIOperation {
    public typealias Response = PortfolioImportOutcome
    public static let operationId = "portfolioImportCsvCustom"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/portfolio/import/csv/custom"
    public let multipart: MultipartFormData
    public init(file: PortfolioImportFile, config: PortfolioImportConfig, adapterName: String) throws {
        multipart = try Self.form(file: file, config: config, adapterName: adapterName)
    }
    static func form(file: PortfolioImportFile, config: PortfolioImportConfig, adapterName: String) throws
        -> MultipartFormData
    {
        guard file.data.count <= PortfolioImportFile.maximumBytes else {
            throw PortfolioImportFailure.unverified("Portfolio statement exceeds the upload limit")
        }
        var form = MultipartFormData()
        form.append(file: "file", filename: file.filename, contentType: file.contentType, data: file.data)
        for (key, value) in try config.multipartFields(adapterName: adapterName) { form.append(key, value) }
        return form
    }
    public var path: String { Self.pathTemplate }
    public var contentType: String { multipart.contentType }
    public func encodedBody() throws -> Data? { multipart.encoded() }
}

public enum PortfolioImportStreamEvents {
    public enum Step: Equatable, Sendable {
        case progress(ImportProgress)
        case finished(PortfolioImportOutcome, ImportProgress)
    }
    public static func handle(_ event: ServerSentEvent) throws -> Step? {
        guard event.data != "[DONE]", ["progress", "complete", "review_required", "error"].contains(event.event) else {
            return nil
        }
        var payload = try JSONDecoder().decode(TaxValue.self, from: Data(event.data.utf8))
        switch event.event {
        case "progress":
            return .progress(try payload.decode(ImportProgress.self))
        case "error":
            let detail = payload["detail"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw PortfolioImportFailure.ambiguous(detail?.isEmpty == false ? detail! : "Import failed")
        case "review_required":
            payload["requires_review"] = .bool(true)
            payload["status"] = .string("review_required")
            let result = try payload.decode(PortfolioImportOutcome.self)
            return .finished(result, ImportProgress(phase: "review_required", percent: 70))
        case "complete":
            let result = try payload.decode(PortfolioImportOutcome.self)
            return .finished(
                result,
                ImportProgress(
                    phase: "complete", imported: result.imported, duplicates: result.duplicates, errors: result.errors,
                    percent: 100))
        default: return nil
        }
    }
}
