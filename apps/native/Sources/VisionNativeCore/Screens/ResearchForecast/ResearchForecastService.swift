import Foundation

/// Forecast-specific additions leave existing ResearchService implementations unchanged.
public protocol ForecastService: ResearchService {
    func researchPortfolioForecast(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchForecastData>
    func readLifeScenarios() async throws -> ResearchLifeScenarioSetting
    func saveLifeScenarios(value: TaxValue, expected: TaxValue) async throws -> ResearchLifeScenarioSetting
}
extension APIClient: ForecastService {
    public func researchPortfolioForecast(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchForecastData> {
        let response = try await sendWithMeta(
            ResearchRequest<OpenAPIOperations.ResearchPortfolioForecast, ResearchForecastData>(
                OpenAPIOperations.ResearchPortfolioForecast.self, body: ResearchForecastWire.body(input)))
        return .init(data: response.data, meta: .init(raw: response.meta))
    }
    public func readLifeScenarios() async throws -> ResearchLifeScenarioSetting {
        try await send(
            ResearchRequest<OpenAPIOperations.GetSetting, ResearchLifeScenarioSetting>(
                OpenAPIOperations.GetSetting.self, parameters: ["key": "life_scenarios"]))
    }
    public func saveLifeScenarios(value: TaxValue, expected: TaxValue) async throws -> ResearchLifeScenarioSetting {
        try await send(
            ResearchRequest<OpenAPIOperations.SaveSetting, ResearchLifeScenarioSetting>(
                OpenAPIOperations.SaveSetting.self, parameters: ["key": "life_scenarios"],
                body: .object(["value": value, "expected": expected])))
    }
}
public enum ResearchForecastWire {
    /// The same camel-to-snake mapping as lib/api/research.getPortfolioForecast.
    public static func body(_ input: TaxValue) -> TaxValue {
        let keys = [
            "horizonMonths": "horizon_months", "monthlyContribution": "monthly_contribution",
            "monthlyContributionSchedule": "monthly_contribution_schedule", "paths": "paths",
            "forwardBlend": "forward_blend", "method": "method", "targetValue": "target_value",
            "goalMonth": "goal_month", "currency": "currency", "seed": "seed",
        ]
        return .object(
            Dictionary(uniqueKeysWithValues: keys.compactMap { source, target in input[source].map { (target, $0) } }))
    }
}
