import Foundation

public protocol TaxDashboardService: Sendable {
    func homeExclusions(scope: String) async throws -> InsightExclusions
    func taxDashboard(year: Int?, query: StatisticsQuery) async throws -> TaxDashboardData
}
extension APIClient: TaxDashboardService {
    public func taxDashboard(year: Int?, query: StatisticsQuery) async throws -> TaxDashboardData {
        var items = query.queryItems()
        if let year { items.append(URLQueryItem(name: "year", value: String(year))) }
        return try await send(
            InsightRequest<OpenAPIOperations.GetBelgianTaxDashboard, TaxDashboardData>(
                OpenAPIOperations.GetBelgianTaxDashboard(), query: items))
    }
}
