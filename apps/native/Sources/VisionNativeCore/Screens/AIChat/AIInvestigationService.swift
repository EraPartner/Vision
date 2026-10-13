import Foundation

public protocol AIInvestigationService: Sendable {
    func investigationStatus() async throws -> AIResearchStatus
    func investigationCreate(_ input: TaxValue) async throws -> AIInvestigation
    func investigationGet(id: String) async throws -> AIInvestigation
    func investigationDelete(id: String) async throws
    func investigationCancel(id: String) async throws -> AIInvestigation
    func investigationResume(id: String, clarification: String, scope: TaxValue) async throws -> AIInvestigation
    func investigationPreview(_ input: TaxValue) async throws -> AIDisclosurePreview
    func investigationGrant(_ input: TaxValue) async throws -> String
    func investigationRecords() async throws -> TaxValue
    func investigationGrants() async throws -> TaxValue
    func investigationRevoke(id: String) async throws
    func investigationDeleteHistory() async throws
    func investigationDocuments() async throws -> [AIResearchDocument]
    func investigationUpload(_ file: AIResearchDocumentFile) async throws -> AIResearchDocument
    func investigationDeleteDocument(id: String) async throws
}
private struct AIInvestigationDocuments: Decodable, Sendable {
    let items: [AIResearchDocument]
    let total: Int
}
extension APIClient: AIInvestigationService {
    public func investigationStatus() async throws -> AIResearchStatus {
        try await send(
            ResearchRequest<OpenAPIOperations.GetAiResearchStatus, AIResearchStatus>(
                OpenAPIOperations.GetAiResearchStatus.self))
    }
    public func investigationCreate(_ input: TaxValue) async throws -> AIInvestigation {
        try await send(
            ResearchRequest<OpenAPIOperations.CreateAiInvestigation, AIInvestigation>(
                OpenAPIOperations.CreateAiInvestigation.self, body: input))
    }
    public func investigationGet(id: String) async throws -> AIInvestigation {
        try await send(
            ResearchRequest<OpenAPIOperations.GetAiInvestigation, AIInvestigation>(
                OpenAPIOperations.GetAiInvestigation.self, parameters: ["id": id]))
    }
    public func investigationDelete(id: String) async throws {
        let _: APIEmpty = try await send(
            ResearchRequest<OpenAPIOperations.DeleteAiInvestigation, APIEmpty>(
                OpenAPIOperations.DeleteAiInvestigation.self, parameters: ["id": id]))
    }
    public func investigationCancel(id: String) async throws -> AIInvestigation {
        try await send(
            ResearchRequest<OpenAPIOperations.CancelAiInvestigation, AIInvestigation>(
                OpenAPIOperations.CancelAiInvestigation.self, parameters: ["id": id]))
    }
    public func investigationResume(id: String, clarification: String, scope: TaxValue) async throws -> AIInvestigation
    {
        try await send(
            ResearchRequest<OpenAPIOperations.ResumeAiInvestigation, AIInvestigation>(
                OpenAPIOperations.ResumeAiInvestigation.self, parameters: ["id": id],
                body: .object(["clarification": .string(clarification), "scope": scope])))
    }
    public func investigationPreview(_ input: TaxValue) async throws -> AIDisclosurePreview {
        try await send(
            ResearchRequest<OpenAPIOperations.PreviewAiDisclosure, AIDisclosurePreview>(
                OpenAPIOperations.PreviewAiDisclosure.self, body: input))
    }
    public func investigationGrant(_ input: TaxValue) async throws -> String {
        let raw = try await send(
            ResearchRequest<OpenAPIOperations.CreateAiDisclosureGrant, TaxValue>(
                OpenAPIOperations.CreateAiDisclosureGrant.self, body: input))
        return try ResearchDecode.string(raw["id"])
    }
    public func investigationRecords() async throws -> TaxValue {
        let raw = try await send(
            ResearchRequest<OpenAPIOperations.ListAiDisclosureRecords, TaxValue>(
                OpenAPIOperations.ListAiDisclosureRecords.self))
        _ = try AIInvestigationDecode.array(raw["items"])
        _ = try ResearchDecode.count(raw["total"])
        return raw
    }
    public func investigationGrants() async throws -> TaxValue {
        let raw = try await send(
            ResearchRequest<OpenAPIOperations.ListAiDisclosureGrants, TaxValue>(
                OpenAPIOperations.ListAiDisclosureGrants.self))
        _ = try AIInvestigationDecode.array(raw["items"])
        _ = try ResearchDecode.count(raw["total"])
        return raw
    }
    public func investigationRevoke(id: String) async throws {
        let raw = try await send(
            ResearchRequest<OpenAPIOperations.RevokeAiDisclosureGrant, TaxValue>(
                OpenAPIOperations.RevokeAiDisclosureGrant.self, parameters: ["id": id]))
        guard raw["revoked"] == .bool(true) else {
            throw ResearchDecode.failure("Invalid disclosure revocation receipt")
        }
    }
    public func investigationDeleteHistory() async throws {
        let raw = try await send(
            ResearchRequest<OpenAPIOperations.DeleteAiDisclosureRecords, TaxValue>(
                OpenAPIOperations.DeleteAiDisclosureRecords.self))
        _ = try ResearchDecode.count(raw["deleted"]?["records"])
        _ = try ResearchDecode.count(raw["deleted"]?["grants"])
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
    public func investigationDeleteDocument(id: String) async throws {
        let _: APIEmpty = try await send(
            ResearchRequest<OpenAPIOperations.DeleteAiResearchDocument, APIEmpty>(
                OpenAPIOperations.DeleteAiResearchDocument.self, parameters: ["id": id]))
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
