import Foundation

public protocol NetWorthService: Sendable {
    func netWorth(currency: String, limit: Int?, offset: Int?) async throws -> OpenAPI.NetWorthResponse
    /// `useNetWorthByAccount(currency)`: the per-account breakdown, converted on the server.
    func netWorthByAccount(currency: String) async throws -> OpenAPI.NetWorthByAccountResponse
    func netWorthPrices() async throws -> [NetWorthInvestmentPrice]
    func refreshNetWorthPrices() async throws -> PortfolioPriceRefresh
}

extension APIClient: NetWorthService {
    public func netWorth(currency: String, limit: Int?, offset: Int?) async throws -> OpenAPI.NetWorthResponse {
        try await send(OpenAPIOperations.GetNetWorth(currency: currency, limit: limit, offset: offset))
    }
    public func netWorthByAccount(currency: String) async throws -> OpenAPI.NetWorthByAccountResponse {
        try await send(OpenAPIOperations.GetNetWorthByAccount(currency: currency))
    }
    public func netWorthPrices() async throws -> [NetWorthInvestmentPrice] {
        var rows: [NetWorthInvestmentPrice] = []
        var offset = 0
        while true {
            let page = try await send(
                InsightRequest<OpenAPIOperations.GetInvestments, NetWorthPricePage>(
                    OpenAPIOperations.GetInvestments(),
                    query: [
                        URLQueryItem(name: "active", value: "true"), URLQueryItem(name: "limit", value: "1000"),
                        URLQueryItem(name: "offset", value: String(offset)),
                    ]))
            guard page.offset == offset, page.total >= offset + page.items.count, page.limit > 0,
                !page.items.isEmpty || offset >= page.total
            else {
                throw APIError.invalidRequest("Incomplete investment price history")
            }
            rows += page.items
            offset += page.items.count
            if offset >= page.total { return rows }
        }
    }
    public func refreshNetWorthPrices() async throws -> PortfolioPriceRefresh {
        try await send(
            InsightRequest<OpenAPIOperations.RefreshInvestmentPrices, PortfolioPriceRefresh>(
                OpenAPIOperations.RefreshInvestmentPrices(), query: []))
    }
}
private struct NetWorthPricePage: Decodable, Sendable {
    let items: [NetWorthInvestmentPrice]
    let total: Int
    let limit: Int
    let offset: Int
}
