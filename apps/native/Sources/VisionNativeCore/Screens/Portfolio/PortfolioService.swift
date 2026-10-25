import Foundation

public protocol PortfolioService: PortfolioWidgetService {
    func portfolioSummary(currency: CurrencyCode, includeArchived: Bool) async throws -> PortfolioSummaryData
    func portfolioInvestments(limit: Int, offset: Int) async throws -> PortfolioPage<PortfolioInvestment>
    func portfolioTransactions(id: InvestmentID, limit: Int, offset: Int) async throws
        -> PortfolioPage<PortfolioTransaction>
    func portfolioAccounts() async throws -> [OpenAPI.Account]
    func portfolioPerformance(currency: CurrencyCode, period: PortfolioPeriod) async throws -> PortfolioPerformanceData
    func portfolioBrokerPerformance(currency: CurrencyCode) async throws -> PortfolioBrokerPerformance
    func portfolioExposure(currency: CurrencyCode) async throws -> PortfolioExposureData
    func portfolioQuotes(symbols: [String]) async throws -> [PortfolioQuote]
    func portfolioNews(symbols: [String]) async throws -> [PortfolioNewsArticle]
    func portfolioRefreshPrices() async throws -> PortfolioPriceRefresh
    func portfolioWidgetSetting() async throws -> OpenAPI.Setting
    func savePortfolioWidgets(value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting
}

extension APIClient: PortfolioService {
    public func portfolioSummary(currency: CurrencyCode, includeArchived: Bool) async throws -> PortfolioSummaryData {
        var query = [URLQueryItem(name: "currency", value: currency.rawValue)]
        if includeArchived { query.append(.init(name: "active", value: "false")) }
        return try await send(
            InsightRequest<OpenAPIOperations.GetPortfolioSummary, PortfolioSummaryData>(
                OpenAPIOperations.GetPortfolioSummary(), query: query))
    }
    public func portfolioInvestments(limit: Int, offset: Int) async throws -> PortfolioPage<PortfolioInvestment> {
        try await send(
            InsightRequest<OpenAPIOperations.GetInvestments, PortfolioPage<PortfolioInvestment>>(
                OpenAPIOperations.GetInvestments(),
                query: [
                    .init(name: "limit", value: String(limit)), .init(name: "offset", value: String(offset)),
                    // `false` means all rows; inactive holdings are selected from their explicit flag.
                    .init(name: "active", value: "false"),
                ]))
    }
    public func portfolioTransactions(id: InvestmentID, limit: Int, offset: Int) async throws -> PortfolioPage<
        PortfolioTransaction
    > {
        try await send(
            InsightRequest<OpenAPIOperations.GetInvestmentTransactions, PortfolioPage<PortfolioTransaction>>(
                OpenAPIOperations.GetInvestmentTransactions(id: id),
                query: [
                    .init(name: "limit", value: String(limit)), .init(name: "offset", value: String(offset)),
                ]))
    }
    public func portfolioAccounts() async throws -> [OpenAPI.Account] {
        try await send(OpenAPIOperations.GetAccounts(active: "all")).items
    }
    public func portfolioPerformance(currency: CurrencyCode, period: PortfolioPeriod) async throws
        -> PortfolioPerformanceData
    {
        try await send(
            InsightRequest<OpenAPIOperations.GetPortfolioPerformance, PortfolioPerformanceData>(
                OpenAPIOperations.GetPortfolioPerformance(),
                query: [
                    .init(name: "currency", value: currency.rawValue), .init(name: "period", value: period.rawValue),
                ]))
    }
    public func portfolioBrokerPerformance(currency: CurrencyCode) async throws -> PortfolioBrokerPerformance {
        try await send(
            InsightRequest<OpenAPIOperations.GetPortfolioPerformanceByBroker, PortfolioBrokerPerformance>(
                OpenAPIOperations.GetPortfolioPerformanceByBroker(),
                query: [.init(name: "currency", value: currency.rawValue)]))
    }
    public func portfolioExposure(currency: CurrencyCode) async throws -> PortfolioExposureData {
        try await send(
            InsightRequest<OpenAPIOperations.GetPortfolioExposure, PortfolioExposureData>(
                OpenAPIOperations.GetPortfolioExposure(), query: [.init(name: "currency", value: currency.rawValue)]))
    }
    public func portfolioQuotes(symbols: [String]) async throws -> [PortfolioQuote] {
        guard !symbols.isEmpty else { return [] }
        return try await send(
            InsightRequest<OpenAPIOperations.MarketQuote, PortfolioPage<PortfolioQuote>>(
                OpenAPIOperations.MarketQuote(symbols: symbols.joined(separator: ",")),
                query: [
                    .init(name: "symbols", value: symbols.joined(separator: ",")),
                    .init(name: "detail", value: "basic"),
                ])
        ).items
    }
    public func portfolioNews(symbols: [String]) async throws -> [PortfolioNewsArticle] {
        var query = [URLQueryItem(name: "count", value: "12")]
        if !symbols.isEmpty { query.append(.init(name: "symbols", value: symbols.joined(separator: ","))) }
        return try await send(
            InsightRequest<OpenAPIOperations.MarketNews, PortfolioPage<PortfolioNewsArticle>>(
                OpenAPIOperations.MarketNews(), query: query)
        ).items
    }
    public func portfolioRefreshPrices() async throws -> PortfolioPriceRefresh {
        try await send(
            InsightRequest<OpenAPIOperations.RefreshInvestmentPrices, PortfolioPriceRefresh>(
                OpenAPIOperations.RefreshInvestmentPrices(), query: []))
    }
    public func portfolioWidgetSetting() async throws -> OpenAPI.Setting {
        try await send(OpenAPIOperations.GetSetting(key: "widget_visibility"))
    }
    public func savePortfolioWidgets(value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        try await send(
            OpenAPIOperations.SaveSetting(key: "widget_visibility", body: .init(value: value, expected: expected)))
    }
}
