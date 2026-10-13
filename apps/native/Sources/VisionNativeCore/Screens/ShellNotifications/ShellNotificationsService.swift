import Foundation

public protocol ShellNotificationsService: Sendable {
    func notificationExchangeRates() async throws -> OpenAPI.ExchangeRates
    func notificationRefreshExchangeRates() async throws
    func notificationUpcoming(start: String, end: String) async throws -> [OpenAPI.PlannedTransaction]
}

extension APIClient: ShellNotificationsService {
    public func notificationExchangeRates() async throws -> OpenAPI.ExchangeRates {
        try await send(OpenAPIOperations.GetExchangeRates(dbOnly: true), retries: 0)
    }
    public func notificationRefreshExchangeRates() async throws {
        _ = try await refreshExchangeRates()
    }
    public func notificationUpcoming(start: String, end: String) async throws -> [OpenAPI.PlannedTransaction] {
        try await homePlanned(start: start, end: end, limit: 100)
    }
}
