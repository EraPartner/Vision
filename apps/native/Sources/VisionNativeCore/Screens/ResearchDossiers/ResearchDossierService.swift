import Foundation

public protocol DossiersService: Sendable {
    func listDossiers(offset: Int) async throws -> ResearchDossierListPage
    func getDossier(id: ResearchDossierID) async throws -> ResearchDossier
    func createDossier(_ content: ResearchDossierContent) async throws -> ResearchDossier
    func updateDossier(id: ResearchDossierID, content: ResearchDossierContent, expectedVersion: Int) async throws
        -> ResearchDossier
    func deleteDossier(id: ResearchDossierID) async throws
    func dossierVersions(id: ResearchDossierID) async throws -> [ResearchDossierVersion]
    func restoreDossier(id: ResearchDossierID, version: Int, expectedVersion: Int) async throws -> ResearchDossier
    func exportDossiers(id: ResearchDossierID?) async throws -> ResearchDossierExport
    func dossierCategories() async throws -> [ResearchDossierPickerItem<CategoryID>]
    func dossierInvestments() async throws -> [ResearchDossierPickerItem<InvestmentID>]
    func dossierAnalyses() async throws -> [ResearchDossierPickerItem<SavedAnalysisID>]
    func dossierDocuments() async throws -> [ResearchDossierDocument]
}
private struct ResearchDossierVersions: Decodable, Sendable { let items: [ResearchDossierVersion] }
private struct ResearchDossierDocuments: Decodable, Sendable { let items: [ResearchDossierDocument] }
extension APIClient: DossiersService {
    public func listDossiers(offset: Int) async throws -> ResearchDossierListPage {
        try await send(
            ResearchRequest<OpenAPIOperations.ListResearchDossiers, ResearchDossierListPage>(
                OpenAPIOperations.ListResearchDossiers.self,
                query: [.init(name: "limit", value: "500"), .init(name: "offset", value: String(offset))]))
    }
    public func getDossier(id: ResearchDossierID) async throws -> ResearchDossier {
        try await send(
            ResearchRequest<OpenAPIOperations.GetResearchDossier, ResearchDossier>(
                OpenAPIOperations.GetResearchDossier.self, parameters: ["id": id.rawValue]))
    }
    public func createDossier(_ content: ResearchDossierContent) async throws -> ResearchDossier {
        try await send(
            ResearchRequest<OpenAPIOperations.CreateResearchDossier, ResearchDossier>(
                OpenAPIOperations.CreateResearchDossier.self, body: content.payload))
    }
    public func updateDossier(id: ResearchDossierID, content: ResearchDossierContent, expectedVersion: Int) async throws
        -> ResearchDossier
    {
        var body = content.payload
        body["expectedVersion"] = .number(Decimal(expectedVersion))
        return try await send(
            ResearchRequest<OpenAPIOperations.UpdateResearchDossier, ResearchDossier>(
                OpenAPIOperations.UpdateResearchDossier.self, parameters: ["id": id.rawValue], body: body))
    }
    public func deleteDossier(id: ResearchDossierID) async throws {
        let _: APIEmpty = try await send(
            ResearchRequest<OpenAPIOperations.DeleteResearchDossier, APIEmpty>(
                OpenAPIOperations.DeleteResearchDossier.self, parameters: ["id": id.rawValue]))
    }
    public func dossierVersions(id: ResearchDossierID) async throws -> [ResearchDossierVersion] {
        try await send(
            ResearchRequest<OpenAPIOperations.ListResearchDossierVersions, ResearchDossierVersions>(
                OpenAPIOperations.ListResearchDossierVersions.self, parameters: ["id": id.rawValue])
        ).items
    }
    public func restoreDossier(id: ResearchDossierID, version: Int, expectedVersion: Int) async throws -> ResearchDossier {
        try await send(
            ResearchRequest<OpenAPIOperations.RestoreResearchDossier, ResearchDossier>(
                OpenAPIOperations.RestoreResearchDossier.self, parameters: ["id": id.rawValue],
                body: .object([
                    "version": .number(Decimal(version)), "expectedVersion": .number(Decimal(expectedVersion)),
                ])))
    }
    public func exportDossiers(id: ResearchDossierID?) async throws -> ResearchDossierExport {
        if let id {
            return try await send(
                ResearchRequest<OpenAPIOperations.ExportResearchDossier, ResearchDossierExport>(
                    OpenAPIOperations.ExportResearchDossier.self, parameters: ["id": id.rawValue]))
        }
        return try await send(
            ResearchRequest<OpenAPIOperations.ExportResearchDossiers, ResearchDossierExport>(
                OpenAPIOperations.ExportResearchDossiers.self))
    }
    public func dossierCategories() async throws -> [ResearchDossierPickerItem<CategoryID>] {
        let raw: TaxValue = try await send(
            ResearchRequest<OpenAPIOperations.GetCategoryTree, TaxValue>(OpenAPIOperations.GetCategoryTree.self))
        return try Self.dossierPickerRows(raw).map { row in
            .init(
                id: CategoryID(try ResearchDecode.count(row["id"])),
                label: try ResearchDecode.required(row["path"], [String].self).joined(separator: " / "))
        }
    }
    public func dossierInvestments() async throws -> [ResearchDossierPickerItem<InvestmentID>] {
        let raw: TaxValue = try await send(
            ResearchRequest<OpenAPIOperations.GetInvestments, TaxValue>(
                OpenAPIOperations.GetInvestments.self, query: [.init(name: "limit", value: "1000")]))
        return try Self.dossierPickerRows(raw).map {
            .init(id: InvestmentID(try ResearchDecode.count($0["id"])), label: try ResearchDecode.string($0["name"]))
        }
    }
    public func dossierAnalyses() async throws -> [ResearchDossierPickerItem<SavedAnalysisID>] {
        let raw: TaxValue = try await send(
            ResearchRequest<OpenAPIOperations.ListSavedAnalyses, TaxValue>(OpenAPIOperations.ListSavedAnalyses.self))
        return try Self.dossierPickerRows(raw).map {
            .init(id: SavedAnalysisID(try ResearchDecode.string($0["id"])), label: try ResearchDecode.string($0["name"]))
        }
    }
    public func dossierDocuments() async throws -> [ResearchDossierDocument] {
        try await send(
            ResearchRequest<OpenAPIOperations.ListAiResearchDocuments, ResearchDossierDocuments>(
                OpenAPIOperations.ListAiResearchDocuments.self)
        ).items
    }
    private static func dossierPickerRows(_ raw: TaxValue) throws -> [TaxValue] {
        guard let rows = raw["items"]?.arrayValue else {
            throw ResearchDecode.failure("Invalid dossier picker collection")
        }
        return rows
    }
}
