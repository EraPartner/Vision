import Foundation

public protocol PortfolioTaxService: Sendable {
    func portfolioTaxDashboard(year: Int, currency: CurrencyCode) async throws -> PortfolioTaxDashboard
    func savePortfolioTaxSettings(_ patch: PortfolioTaxSettingsPatch) async throws
    func portfolioTaxWidgetSetting() async throws -> OpenAPI.Setting
    func savePortfolioTaxWidgets(value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting
}

extension APIClient: PortfolioTaxService {
    public func portfolioTaxDashboard(year: Int, currency: CurrencyCode) async throws -> PortfolioTaxDashboard {
        let result = try await send(
            InsightRequest<OpenAPIOperations.GetBelgianPortfolioTaxDashboard, PortfolioTaxDashboard>(
                OpenAPIOperations.GetBelgianPortfolioTaxDashboard(),
                query: [
                    URLQueryItem(name: "year", value: String(year)), URLQueryItem(name: "currency", value: currency.rawValue),
                ]))
        try result.validate(year: year, currency: currency)
        return result
    }
    public func savePortfolioTaxSettings(_ patch: PortfolioTaxSettingsPatch) async throws {
        let result = try await send(PortfolioTaxSettingsOperation(patch: patch))
        guard result.saved == patch.settings.count else {
            throw APIError.contract(
                APIContractError(
                    endpoint: "/api/settings", issues: ["saved: does not match the submitted settings count"]))
        }
    }
    public func portfolioTaxWidgetSetting() async throws -> OpenAPI.Setting {
        try await send(OpenAPIOperations.GetSetting(key: PortfolioTaxWidgetsModel.settingsKey))
    }
    public func savePortfolioTaxWidgets(value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        try await send(
            OpenAPIOperations.SaveSetting(
                key: PortfolioTaxWidgetsModel.settingsKey,
                body: OpenAPIOperations.SaveSetting.Body(value: value, expected: try OpenAPI.SettingBaseline(json: expected))))
    }
}
private struct PortfolioTaxSettingsOperation: APIOperation {
    static let operationId = OpenAPIOperations.SaveSettings.operationId
    static let method = OpenAPIOperations.SaveSettings.method
    static let pathTemplate = OpenAPIOperations.SaveSettings.pathTemplate
    var path: String { Self.pathTemplate }
    let patch: PortfolioTaxSettingsPatch
    func encodedBody() throws -> Data? { try APIBody.encode(patch) }
    struct Response: Decodable, Sendable { let saved: Int }
}
