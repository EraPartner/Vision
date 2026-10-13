import Foundation

public struct PortfolioPriceProvider: Decodable, Equatable, Sendable, Identifiable {
    public var id: String { key }
    public let key: String
    public let name: String
    public let description: String
    public init(key: String, name: String, description: String) {
        self.key = key
        self.name = name
        self.description = description
    }
    public static let fallback: [Self] = [
        .init(key: "manual", name: "Manual", description: ""), .init(key: "binance", name: "Binance", description: ""),
        .init(key: "yahoo", name: "Yahoo Finance", description: ""),
        .init(key: "custom", name: "Custom JSON", description: ""),
        .init(key: "kinesis", name: "Kinesis", description: ""),
    ]
}

public protocol PortfolioEditingService: Sendable {
    func portfolioCreateInvestment(_ payload: PortfolioEditingPayload) async throws -> PortfolioInvestment
    func portfolioUpdateInvestment(id: Int, payload: PortfolioEditingPayload) async throws -> PortfolioInvestment
    func portfolioDeleteInvestment(id: Int) async throws
    func portfolioCreateTransaction(investmentId: Int, payload: PortfolioEditingPayload) async throws
        -> PortfolioTransaction
    func portfolioUpdateTransaction(id: Int, payload: PortfolioEditingPayload) async throws -> PortfolioTransaction
    func portfolioDeleteTransaction(id: Int) async throws
    func portfolioPriceProviders() async throws -> [PortfolioPriceProvider]
    func portfolioEditingTransactions(investmentIds: [Int]) async throws -> [PortfolioTransaction]
    func portfolioEditingAccounts() async throws -> [OpenAPI.Account]
    func portfolioRetagLots(_ payload: PortfolioEditingPayload) async throws -> OpenAPI.PortfolioBrokerRetagReceipt
    func portfolioImportExposure(_ data: Data) async throws
}

extension APIClient: PortfolioEditingService {
    public func portfolioCreateInvestment(_ payload: PortfolioEditingPayload) async throws -> PortfolioInvestment {
        try await send(
            PortfolioEditingRequest<OpenAPIOperations.CreateInvestment, PortfolioInvestment>(
                path: "/api/investments", payload: payload))
    }
    public func portfolioUpdateInvestment(id: Int, payload: PortfolioEditingPayload) async throws -> PortfolioInvestment
    {
        try await send(
            PortfolioEditingRequest<OpenAPIOperations.UpdateInvestment, PortfolioInvestment>(
                path: "/api/investments/\(id)", payload: payload))
    }
    public func portfolioDeleteInvestment(id: Int) async throws {
        _ = try await send(
            PortfolioEditingRequest<OpenAPIOperations.DeleteInvestment, APIEmpty>(path: "/api/investments/\(id)"))
    }
    public func portfolioCreateTransaction(investmentId: Int, payload: PortfolioEditingPayload) async throws
        -> PortfolioTransaction
    {
        try await send(
            PortfolioEditingRequest<OpenAPIOperations.CreateInvestmentTransaction, PortfolioTransaction>(
                path: "/api/investments/\(investmentId)/transactions", payload: payload))
    }
    public func portfolioUpdateTransaction(id: Int, payload: PortfolioEditingPayload) async throws
        -> PortfolioTransaction
    {
        try await send(
            PortfolioEditingRequest<OpenAPIOperations.UpdatePortfolioTransaction, PortfolioTransaction>(
                path: "/api/investments/transactions/\(id)", payload: payload))
    }
    public func portfolioDeleteTransaction(id: Int) async throws {
        _ = try await send(
            PortfolioEditingRequest<OpenAPIOperations.DeletePortfolioTransaction, APIEmpty>(
                path: "/api/investments/transactions/\(id)"))
    }
    public func portfolioPriceProviders() async throws -> [PortfolioPriceProvider] {
        try await send(
            PortfolioEditingRequest<OpenAPIOperations.ListInvestmentProviders, PortfolioProvidersResponse>(
                path: "/api/investments/providers")
        ).providers
    }
    public func portfolioEditingTransactions(investmentIds: [Int]) async throws -> [PortfolioTransaction] {
        guard !investmentIds.isEmpty else { return [] }
        do {
            return try await send(
                PortfolioEditingRequest<
                    OpenAPIOperations.GetBulkPortfolioTransactions, PortfolioPage<PortfolioTransaction>
                >(
                    path: "/api/investments/transactions",
                    queryItems: [
                        .init(name: "investment_ids", value: investmentIds.map(String.init).joined(separator: ",")),
                        .init(name: "per_investment_limit", value: "1000"),
                    ])
            ).items
        } catch {
            try Task.checkCancellation()
            return try await withThrowingTaskGroup(of: [PortfolioTransaction].self) { group in
                for id in investmentIds {
                    group.addTask {
                        try await self.send(
                            PortfolioEditingRequest<
                                OpenAPIOperations.GetInvestmentTransactions, PortfolioPage<PortfolioTransaction>
                            >(
                                path: "/api/investments/\(id)/transactions",
                                queryItems: [.init(name: "limit", value: "1000")])
                        ).items
                    }
                }
                var rows: [PortfolioTransaction] = []
                for try await values in group { rows.append(contentsOf: values) }
                return rows
            }
        }
    }
    public func portfolioEditingAccounts() async throws -> [OpenAPI.Account] {
        try await send(OpenAPIOperations.GetAccounts(active: "true")).items
    }
    public func portfolioRetagLots(_ payload: PortfolioEditingPayload) async throws
        -> OpenAPI.PortfolioBrokerRetagReceipt
    {
        try await send(
            PortfolioEditingRequest<
                OpenAPIOperations.BulkRetagPortfolioTransactions, OpenAPI.PortfolioBrokerRetagReceipt
            >(path: "/api/investments/transactions/broker", payload: payload))
    }
    public func portfolioImportExposure(_ data: Data) async throws {
        _ = try await send(
            PortfolioEditingRequest<OpenAPIOperations.UpsertPortfolioExposureSources, APIEmpty>(
                path: "/api/investments/exposure/sources", body: data))
    }
}
private struct PortfolioProvidersResponse: Decodable, Sendable { let providers: [PortfolioPriceProvider] }
private struct PortfolioEditingRequest<Operation: APIOperation, Response: Decodable & Sendable>: APIOperation {
    static var operationId: String { Operation.operationId }
    static var method: HTTPMethod { Operation.method }
    static var pathTemplate: String { Operation.pathTemplate }
    let path: String
    var payload: PortfolioEditingPayload? = nil
    var body: Data? = nil
    var queryItems: [URLQueryItem] = []
    func encodedBody() throws -> Data? {
        if let body { return body }
        return try payload.map { try APIBody.encode($0) }
    }
}
