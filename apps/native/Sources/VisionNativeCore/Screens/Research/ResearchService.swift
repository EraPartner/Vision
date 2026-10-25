import Foundation

public protocol ResearchService: Sendable {
    func researchSearch(query: String) async throws -> ResearchSnapshot<ResearchSearchData>
    func marketSearch(query: String) async throws -> ResearchSearchData
    func marketQuotes(symbols: [String], detail: String) async throws -> [ResearchQuote]
    func marketChart(symbol: String, range: String, interval: String) async throws -> ResearchChartData
    func marketNews(symbols: [String], count: Int) async throws -> [ResearchNewsArticle]
    func researchChart(symbol: String, range: String, assetClass: String?, provider: String?) async throws
        -> ResearchSnapshot<ResearchChartData>
    func researchScorecard(symbol: String, assetClass: String?) async throws -> ResearchSnapshot<ResearchScorecardData?>
    func researchAnalyst(symbol: String) async throws -> ResearchSnapshot<ResearchAnalystData?>
    func researchNews(symbol: String) async throws -> ResearchSnapshot<ResearchNewsData>
    func researchWatchlist() async throws -> ResearchWatchlistPage
    func researchCreateWatchlist(_ input: TaxValue) async throws -> ResearchWatchlistItem
    func researchUpdateWatchlist(id: Int, input: TaxValue) async throws -> ResearchWatchlistItem
    func researchDeleteWatchlist(id: Int) async throws
    func researchInvestments() async throws -> [PortfolioInvestment]
    func researchPortfolioSummary(currency: String) async throws -> PortfolioSummaryData
    func researchPriceHistory(id: Int, fromMs: Decimal, dbOnly: Bool) async throws -> ResearchPriceHistoryData
    func researchMappings(instrumentKey: String, keyType: String) async throws -> ResearchSnapshot<ResearchMappingsData>
    func researchResolveMappings(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchMappingResolveData>
    func researchSaveMappings(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchMappingsData>
    func researchDeleteMapping(id: Int) async throws
    func researchAuditMappings(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchMappingAuditData>
    func researchCreateInvestment(_ input: TaxValue) async throws -> PortfolioInvestment
    func researchCreateTransaction(investmentId: Int, input: TaxValue) async throws -> PortfolioTransaction
    func researchPresentation(_ input: TaxValue) async throws -> TaxValue
}
public struct ResearchRequest<Operation: APIOperation, Value: Decodable & Sendable>: APIOperation {
    public typealias Response = Value
    public static var operationId: String { Operation.operationId }
    public static var method: HTTPMethod { Operation.method }
    public static var pathTemplate: String { Operation.pathTemplate }
    public let path: String
    public let queryItems: [URLQueryItem]
    private let body: TaxValue?
    public init(
        _ operation: Operation.Type, parameters: [String: String] = [:], query: [URLQueryItem] = [],
        body: TaxValue? = nil
    ) {
        var path = Operation.pathTemplate
        for (key, value) in parameters {
            path = path.replacingOccurrences(of: "{" + key + "}", with: APIPath.segment(value))
        }
        self.path = path
        queryItems = query
        self.body = body
    }
    public var contentType: String { "application/json" }
    public func encodedBody() throws -> Data? { try body.map { try APIBody.encode($0) } }
}
private struct ResearchCollection<Value: Decodable & Sendable>: Decodable, Sendable {
    let items: [Value]
    let total: Int
}
extension APIClient: ResearchService {
    private func researchSnapshot<Operation: APIOperation, Value: Decodable & Sendable>(
        _ request: ResearchRequest<Operation, Value>
    ) async throws -> ResearchSnapshot<Value> {
        let response = try await sendWithMeta(request)
        return .init(data: response.data, meta: .init(raw: response.meta))
    }
    public func researchSearch(query: String) async throws -> ResearchSnapshot<ResearchSearchData> {
        try await researchSnapshot(
            ResearchRequest<OpenAPIOperations.ResearchSearch, ResearchSearchData>(
                OpenAPIOperations.ResearchSearch.self, query: [.init(name: "q", value: query)]))
    }
    public func marketSearch(query: String) async throws -> ResearchSearchData {
        try await send(
            ResearchRequest<OpenAPIOperations.MarketSearch, ResearchSearchData>(
                OpenAPIOperations.MarketSearch.self, query: [.init(name: "q", value: query)]))
    }
    public func marketQuotes(symbols: [String], detail: String) async throws -> [ResearchQuote] {
        try await send(
            ResearchRequest<OpenAPIOperations.MarketQuote, ResearchCollection<ResearchQuote>>(
                OpenAPIOperations.MarketQuote.self,
                query: [
                    .init(name: "symbols", value: symbols.joined(separator: ",")), .init(name: "detail", value: detail),
                ])
        ).items
    }
    public func marketChart(symbol: String, range: String, interval: String) async throws -> ResearchChartData {
        try await send(
            ResearchRequest<OpenAPIOperations.MarketChart, ResearchChartData>(
                OpenAPIOperations.MarketChart.self,
                query: [
                    .init(name: "symbol", value: symbol), .init(name: "range", value: range),
                    .init(name: "interval", value: interval),
                ]))
    }
    public func marketNews(symbols: [String], count: Int) async throws -> [ResearchNewsArticle] {
        try await send(
            ResearchRequest<OpenAPIOperations.MarketNews, ResearchCollection<ResearchNewsArticle>>(
                OpenAPIOperations.MarketNews.self,
                query: [.init(name: "count", value: String(count))]
                    + (symbols.isEmpty ? [] : [.init(name: "symbols", value: symbols.joined(separator: ","))]))
        ).items
    }
    public func researchChart(symbol: String, range: String, assetClass: String?, provider: String?) async throws
        -> ResearchSnapshot<ResearchChartData>
    {
        try await researchSnapshot(
            ResearchRequest<OpenAPIOperations.ResearchChart, ResearchChartData>(
                OpenAPIOperations.ResearchChart.self,
                query: [.init(name: "symbol", value: symbol), .init(name: "range", value: range)]
                    + (assetClass.map { [.init(name: "asset_class", value: $0)] } ?? [])
                    + (provider.map { [.init(name: "provider", value: $0)] } ?? [])))
    }
    public func researchScorecard(symbol: String, assetClass: String?) async throws -> ResearchSnapshot<
        ResearchScorecardData?
    > {
        try await researchSnapshot(
            ResearchRequest<OpenAPIOperations.ResearchScorecard, ResearchScorecardData?>(
                OpenAPIOperations.ResearchScorecard.self,
                query: [.init(name: "symbol", value: symbol)]
                    + (assetClass.map { [.init(name: "asset_class", value: $0)] } ?? [])))
    }
    public func researchAnalyst(symbol: String) async throws -> ResearchSnapshot<ResearchAnalystData?> {
        try await researchSnapshot(
            ResearchRequest<OpenAPIOperations.ResearchAnalyst, ResearchAnalystData?>(
                OpenAPIOperations.ResearchAnalyst.self, query: [.init(name: "symbol", value: symbol)]))
    }
    public func researchNews(symbol: String) async throws -> ResearchSnapshot<ResearchNewsData> {
        try await researchSnapshot(
            ResearchRequest<OpenAPIOperations.ResearchNews, ResearchNewsData>(
                OpenAPIOperations.ResearchNews.self, query: [.init(name: "symbol", value: symbol)]))
    }
    public func researchWatchlist() async throws -> ResearchWatchlistPage {
        try await send(
            ResearchRequest<OpenAPIOperations.GetWatchlist, ResearchWatchlistPage>(OpenAPIOperations.GetWatchlist.self))
    }
    public func researchCreateWatchlist(_ input: TaxValue) async throws -> ResearchWatchlistItem {
        try await send(
            ResearchRequest<OpenAPIOperations.AddToWatchlist, ResearchWatchlistItem>(
                OpenAPIOperations.AddToWatchlist.self, body: input))
    }
    public func researchUpdateWatchlist(id: Int, input: TaxValue) async throws -> ResearchWatchlistItem {
        try await send(
            ResearchRequest<OpenAPIOperations.UpdateWatchlistItem, ResearchWatchlistItem>(
                OpenAPIOperations.UpdateWatchlistItem.self, parameters: ["id": String(id)], body: input))
    }
    public func researchDeleteWatchlist(id: Int) async throws {
        let _: APIEmpty = try await send(
            ResearchRequest<OpenAPIOperations.DeleteWatchlistItem, APIEmpty>(
                OpenAPIOperations.DeleteWatchlistItem.self, parameters: ["id": String(id)]))
    }
    public func researchInvestments() async throws -> [PortfolioInvestment] {
        try await send(
            ResearchRequest<OpenAPIOperations.GetInvestments, ResearchCollection<PortfolioInvestment>>(
                OpenAPIOperations.GetInvestments.self,
                query: [.init(name: "limit", value: "500"), .init(name: "active", value: "false")])
        ).items
    }
    public func researchPortfolioSummary(currency: String) async throws -> PortfolioSummaryData {
        try await send(
            ResearchRequest<OpenAPIOperations.GetPortfolioSummary, PortfolioSummaryData>(
                OpenAPIOperations.GetPortfolioSummary.self, query: [.init(name: "currency", value: currency)]))
    }
    public func researchPriceHistory(id: Int, fromMs: Decimal, dbOnly: Bool) async throws -> ResearchPriceHistoryData {
        try await send(
            ResearchRequest<OpenAPIOperations.GetInvestmentPriceHistory, ResearchPriceHistoryData>(
                OpenAPIOperations.GetInvestmentPriceHistory.self, parameters: ["id": String(id)],
                query: [
                    .init(name: "from_ms", value: NSDecimalNumber(decimal: fromMs).stringValue),
                    .init(name: "db_only", value: String(dbOnly)),
                ]))
    }
    public func researchMappings(instrumentKey: String, keyType: String) async throws -> ResearchSnapshot<
        ResearchMappingsData
    > {
        try await researchSnapshot(
            ResearchRequest<OpenAPIOperations.ResearchListMappings, ResearchMappingsData>(
                OpenAPIOperations.ResearchListMappings.self,
                query: [.init(name: "instrument_key", value: instrumentKey), .init(name: "key_type", value: keyType)]))
    }
    public func researchResolveMappings(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchMappingResolveData>
    {
        try await researchSnapshot(
            ResearchRequest<OpenAPIOperations.ResearchResolveMappings, ResearchMappingResolveData>(
                OpenAPIOperations.ResearchResolveMappings.self, body: input))
    }
    public func researchSaveMappings(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchMappingsData> {
        try await researchSnapshot(
            ResearchRequest<OpenAPIOperations.ResearchSaveMappings, ResearchMappingsData>(
                OpenAPIOperations.ResearchSaveMappings.self, body: input))
    }
    public func researchDeleteMapping(id: Int) async throws {
        let _: APIEmpty = try await send(
            ResearchRequest<OpenAPIOperations.ResearchDeleteMapping, APIEmpty>(
                OpenAPIOperations.ResearchDeleteMapping.self, parameters: ["id": String(id)]))
    }
    public func researchAuditMappings(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchMappingAuditData> {
        try await researchSnapshot(
            ResearchRequest<OpenAPIOperations.ResearchAuditMappings, ResearchMappingAuditData>(
                OpenAPIOperations.ResearchAuditMappings.self, body: input))
    }
    public func researchCreateInvestment(_ input: TaxValue) async throws -> PortfolioInvestment {
        try await send(
            ResearchRequest<OpenAPIOperations.CreateInvestment, PortfolioInvestment>(
                OpenAPIOperations.CreateInvestment.self, body: input))
    }
    public func researchCreateTransaction(investmentId: Int, input: TaxValue) async throws -> PortfolioTransaction {
        try await send(
            ResearchRequest<OpenAPIOperations.CreateInvestmentTransaction, PortfolioTransaction>(
                OpenAPIOperations.CreateInvestmentTransaction.self, parameters: ["id": String(investmentId)],
                body: input))
    }
    /// Runs in the app from the Swift port of the shared TypeScript (`ResearchPresentation`); there is
    /// no `/api/research/presentation` endpoint.
    public func researchPresentation(_ input: TaxValue) async throws -> TaxValue {
        try ResearchPresentation.compute(input)
    }
}
