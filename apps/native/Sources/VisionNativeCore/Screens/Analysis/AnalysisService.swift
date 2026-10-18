import Foundation

public protocol AnalysisService: AnalysisInterchangeService {
    func analysisCatalog() async throws -> AnalysisCatalog
    func analysisExecute(_ input: TaxValue) async throws -> AnalysisResult
    func analysisCancel(requestId: String) async throws -> TaxValue
    func analysisDrill(plan: AnalysisPlan, row: AnalysisRow, requestId: String) async throws -> AnalysisResult
    func analysisPivot(plan: AnalysisPlan, config: AnalysisPivotConfig, requestId: String) async throws
        -> AnalysisPivotResult
    func evaluateExtension(_ input: TaxValue) async throws -> AnalysisExtensionOutput
    func analysisSaved(workspace: AnalysisWorkspace?) async throws -> [AnalysisSaved]
    func analysisSave(id: String?, input: TaxValue) async throws -> AnalysisSaved
    func analysisRunSaved(id: String) async throws -> AnalysisSaved
    func analysisDeleteSaved(id: String) async throws
    func analysisVersions(id: String) async throws -> [AnalysisSavedVersion]
    func analysisRestore(id: String, version: Int, expectedVersion: Int) async throws -> AnalysisSaved
    func analysisPreviewProposal(_ proposal: AnalysisEditProposal) async throws -> AnalysisProposalPreview
    func analysisApplyProposal(_ proposal: AnalysisEditProposal) async throws -> AnalysisSaved
    func analysisGenerateProposal(id: String, instruction: String, model: String?) async throws
        -> AnalysisProposalPreview
}

/// Uses the generated endpoint metadata with a Decimal-preserving dynamic body.
public struct AnalysisRequest<Operation: APIOperation, Value: Decodable & Sendable>: APIOperation {
    public typealias Response = Value
    public static var operationId: String { Operation.operationId }
    public static var method: HTTPMethod { Operation.method }
    public static var pathTemplate: String { Operation.pathTemplate }
    public let path: String
    public let queryItems: [URLQueryItem]
    public let body: TaxValue?
    public init(
        _ operation: Operation.Type, parameters: [String: String] = [:], query: [URLQueryItem] = [],
        body: TaxValue? = nil
    ) {
        var path = Operation.pathTemplate
        for (key, value) in parameters {
            path = path.replacingOccurrences(of: "{\(key)}", with: APIPath.segment(value))
        }
        self.path = path
        queryItems = query
        self.body = body
    }
    public func encodedBody() throws -> Data? { try body.map { try APIBody.encode($0) } }
}
private struct AnalysisCollection<T: Decodable & Sendable>: Decodable, Sendable {
    let items: [T]
    let total: Int?
}

extension APIClient: AnalysisService {
    public func analysisCatalog() async throws -> AnalysisCatalog {
        try await send(AnalysisRequest(OpenAPIOperations.GetAnalysisCatalog.self))
    }
    public func analysisExecute(_ input: TaxValue) async throws -> AnalysisResult {
        let result: AnalysisResult = try await send(
            AnalysisRequest(OpenAPIOperations.ExecuteAnalysis.self, body: input))
        if let expected = input["requestId"]?.stringValue, result.requestId != expected {
            throw AnalysisDecode.failure("Analysis result belongs to a different request")
        }
        if result.window.kind == "page", let expected = input["offset"]?.decimalValue,
            result.window.offset.map({ Decimal($0) }) != expected
        {
            throw AnalysisDecode.failure("Analysis result belongs to a different page")
        }
        return result
    }
    public func analysisCancel(requestId: String) async throws -> TaxValue {
        try await send(AnalysisRequest(OpenAPIOperations.CancelAnalysis.self, parameters: ["requestId": requestId]))
    }
    public func analysisDrill(plan: AnalysisPlan, row: AnalysisRow, requestId: String) async throws -> AnalysisResult {
        let input: TaxValue = .object([
            "plan": try TaxValue(encoding: plan), "row": .object(row), "requestId": .string(requestId),
        ])
        let result: AnalysisResult = try await send(AnalysisRequest(OpenAPIOperations.DrillAnalysis.self, body: input))
        if result.requestId != requestId {
            throw AnalysisDecode.failure("Drill result belongs to a different request")
        }
        return result
    }
    public func analysisPivot(plan: AnalysisPlan, config: AnalysisPivotConfig, requestId: String) async throws
        -> AnalysisPivotResult
    {
        try await send(
            AnalysisRequest(
                OpenAPIOperations.ExecuteAnalysisPivot.self,
                body: .object([
                    "plan": try TaxValue(encoding: plan), "config": try TaxValue(encoding: config),
                    "requestId": .string(requestId),
                ])))
    }
    public func evaluateExtension(_ input: TaxValue) async throws -> AnalysisExtensionOutput {
        try await send(AnalysisRequest(OpenAPIOperations.EvaluateAnalysisExtension.self, body: input))
    }
    public func analysisSaved(workspace: AnalysisWorkspace?) async throws -> [AnalysisSaved] {
        let result: AnalysisCollection<AnalysisSaved> = try await send(
            AnalysisRequest(
                OpenAPIOperations.ListSavedAnalyses.self,
                query: workspace.map { [URLQueryItem(name: "workspace", value: $0.rawValue)] } ?? []))
        guard Set(result.items.map(\.id)).count == result.items.count else {
            throw AnalysisDecode.failure("Repeated saved analysis identifier")
        }
        return result.items
    }
    public func analysisSave(id: String?, input: TaxValue) async throws -> AnalysisSaved {
        if let id {
            return try await send(
                AnalysisRequest(OpenAPIOperations.UpdateSavedAnalysis.self, parameters: ["id": id], body: input))
        }
        return try await send(AnalysisRequest(OpenAPIOperations.CreateSavedAnalysis.self, body: input))
    }
    public func analysisRunSaved(id: String) async throws -> AnalysisSaved {
        try await send(AnalysisRequest(OpenAPIOperations.RunSavedAnalysis.self, parameters: ["id": id]))
    }
    public func analysisDeleteSaved(id: String) async throws {
        let _: APIEmpty = try await send(
            AnalysisRequest(OpenAPIOperations.DeleteSavedAnalysis.self, parameters: ["id": id]))
    }
    public func analysisVersions(id: String) async throws -> [AnalysisSavedVersion] {
        let page: AnalysisCollection<AnalysisSavedVersion> = try await send(
            AnalysisRequest(OpenAPIOperations.ListSavedAnalysisVersions.self, parameters: ["id": id]))
        return page.items
    }
    public func analysisRestore(id: String, version: Int, expectedVersion: Int) async throws -> AnalysisSaved {
        try await send(
            AnalysisRequest(
                OpenAPIOperations.RestoreSavedAnalysisVersion.self, parameters: ["id": id],
                body: .object([
                    "version": .number(Decimal(version)), "expectedVersion": .number(Decimal(expectedVersion)),
                ])))
    }
    public func analysisPreviewProposal(_ proposal: AnalysisEditProposal) async throws -> AnalysisProposalPreview {
        try await send(
            AnalysisRequest(OpenAPIOperations.PreviewAnalysisProposal.self, body: try TaxValue(encoding: proposal)))
    }
    public func analysisApplyProposal(_ proposal: AnalysisEditProposal) async throws -> AnalysisSaved {
        try await send(
            AnalysisRequest(OpenAPIOperations.ApplyAnalysisProposal.self, body: try TaxValue(encoding: proposal)))
    }
    public func analysisGenerateProposal(id: String, instruction: String, model: String?) async throws
        -> AnalysisProposalPreview
    {
        var body: TaxValue = .object(["instruction": .string(instruction)])
        if let model { body["model"] = .string(model) }
        return try await send(
            AnalysisRequest(OpenAPIOperations.GenerateAnalysisProposal.self, parameters: ["id": id], body: body))
    }
}
