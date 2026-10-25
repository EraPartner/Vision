import Foundation

public protocol TaxSettingsService: Sendable {
    func saveTaxSettings(_ patch: TaxSettingsPatch) async throws
}

extension APIClient: TaxSettingsService {
    public func saveTaxSettings(_ patch: TaxSettingsPatch) async throws {
        let result = try await send(TaxSettingsRequest(patch: patch))
        guard result.saved == patch.settings.count else {
            throw APIError.contract(
                APIContractError(
                    endpoint: "/api/settings", issues: ["saved: does not match the submitted settings count"]))
        }
    }
}

private struct TaxSettingsRequest: APIOperation {
    static let operationId = OpenAPIOperations.SaveSettings.operationId
    static let method = OpenAPIOperations.SaveSettings.method
    static let pathTemplate = OpenAPIOperations.SaveSettings.pathTemplate
    var path: String { Self.pathTemplate }
    let patch: TaxSettingsPatch
    func encodedBody() throws -> Data? { try APIBody.encode(patch) }
    struct Response: Decodable, Sendable { let saved: Int }
}
