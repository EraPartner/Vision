import Foundation

public protocol AIInvestigationService: Sendable {
    func investigationCreate(_ input: TaxValue) async throws -> AIInvestigation
    func investigationGet(id: AiInvestigationID) async throws -> AIInvestigation
    func investigationDelete(id: AiInvestigationID) async throws
    func investigationCancel(id: AiInvestigationID) async throws -> AIInvestigation
    func investigationResume(id: AiInvestigationID, clarification: String, scope: TaxValue) async throws -> AIInvestigation
    func investigationDocuments() async throws -> [AIResearchDocument]
    func investigationUpload(_ file: AIResearchDocumentFile) async throws -> AIResearchDocument
    func investigationDeleteDocument(id: ResearchDocumentID) async throws
}
private struct AIInvestigationDocuments: Decodable, Sendable {
    let items: [AIResearchDocument]
    let total: Int
}
extension APIClient: AIInvestigationService {
    public func investigationCreate(_ input: TaxValue) async throws -> AIInvestigation {
        try await send(
            ResearchRequest<OpenAPIOperations.CreateAiInvestigation, AIInvestigation>(
                OpenAPIOperations.CreateAiInvestigation.self, body: input))
    }
    public func investigationGet(id: AiInvestigationID) async throws -> AIInvestigation {
        try await send(
            ResearchRequest<OpenAPIOperations.GetAiInvestigation, AIInvestigation>(
                OpenAPIOperations.GetAiInvestigation.self, parameters: ["id": id.rawValue]))
    }
    public func investigationDelete(id: AiInvestigationID) async throws {
        let _: APIEmpty = try await send(
            ResearchRequest<OpenAPIOperations.DeleteAiInvestigation, APIEmpty>(
                OpenAPIOperations.DeleteAiInvestigation.self, parameters: ["id": id.rawValue]))
    }
    public func investigationCancel(id: AiInvestigationID) async throws -> AIInvestigation {
        try await send(
            ResearchRequest<OpenAPIOperations.CancelAiInvestigation, AIInvestigation>(
                OpenAPIOperations.CancelAiInvestigation.self, parameters: ["id": id.rawValue]))
    }
    public func investigationResume(id: AiInvestigationID, clarification: String, scope: TaxValue) async throws -> AIInvestigation
    {
        try await send(
            ResearchRequest<OpenAPIOperations.ResumeAiInvestigation, AIInvestigation>(
                OpenAPIOperations.ResumeAiInvestigation.self, parameters: ["id": id.rawValue],
                body: .object(["clarification": .string(clarification), "scope": scope])))
    }
    public func investigationDocuments() async throws -> [AIResearchDocument] {
        let response = try await send(
            ResearchRequest<OpenAPIOperations.ListAiResearchDocuments, AIInvestigationDocuments>(
                OpenAPIOperations.ListAiResearchDocuments.self))
        guard response.total >= 0 else { throw ResearchDecode.failure("Invalid research document total") }
        return response.items
    }
    public func investigationUpload(_ file: AIResearchDocumentFile) async throws -> AIResearchDocument {
        try await send(AIInvestigationUploadRequest(file: file))
    }
    public func investigationDeleteDocument(id: ResearchDocumentID) async throws {
        let _: APIEmpty = try await send(
            ResearchRequest<OpenAPIOperations.DeleteAiResearchDocument, APIEmpty>(
                OpenAPIOperations.DeleteAiResearchDocument.self, parameters: ["id": id.rawValue]))
    }
}
public struct AIInvestigationUploadRequest: APIOperation {
    public typealias Response = AIResearchDocument
    public static let operationId = "createAiResearchDocument"
    public static let method = HTTPMethod.post
    public static let pathTemplate = "/api/ai-research/documents"
    public let multipart: MultipartFormData
    public init(file: AIResearchDocumentFile) {
        var form = MultipartFormData()
        form.append(file: "file", filename: file.name, contentType: file.contentType, data: file.data)
        multipart = form
    }
    public var path: String { Self.pathTemplate }
    public var contentType: String { multipart.contentType }
    public func encodedBody() throws -> Data? { multipart.encoded() }
}
