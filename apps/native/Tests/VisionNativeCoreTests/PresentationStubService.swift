import Foundation

@testable import VisionNativeCore

/// A `ResearchService` for tests that need to observe, pause or script the research presentation.
/// The presentation runs in the app (`ResearchPresentation`), so a transport never sees it; every
/// other call goes to the wrapped client and its transport.
struct PresentationStubService: ResearchService {
    let base: APIClient
    let presentation: @Sendable (TaxValue) async throws -> TaxValue

    func researchSearch(query: String) async throws -> ResearchSnapshot<ResearchSearchData> {
        try await base.researchSearch(query: query)
    }
    func marketSearch(query: String) async throws -> ResearchSearchData { try await base.marketSearch(query: query) }
    func marketQuotes(symbols: [String], detail: String) async throws -> [ResearchQuote] {
        try await base.marketQuotes(symbols: symbols, detail: detail)
    }
    func marketChart(symbol: String, range: String, interval: String) async throws -> ResearchChartData {
        try await base.marketChart(symbol: symbol, range: range, interval: interval)
    }
    func marketNews(symbols: [String], count: Int) async throws -> [ResearchNewsArticle] {
        try await base.marketNews(symbols: symbols, count: count)
    }
    func researchChart(symbol: String, range: String, assetClass: String?, provider: String?) async throws
        -> ResearchSnapshot<ResearchChartData>
    { try await base.researchChart(symbol: symbol, range: range, assetClass: assetClass, provider: provider) }
    func researchScorecard(symbol: String, assetClass: String?) async throws -> ResearchSnapshot<ResearchScorecardData?> {
        try await base.researchScorecard(symbol: symbol, assetClass: assetClass)
    }
    func researchAnalyst(symbol: String) async throws -> ResearchSnapshot<ResearchAnalystData?> {
        try await base.researchAnalyst(symbol: symbol)
    }
    func researchNews(symbol: String) async throws -> ResearchSnapshot<ResearchNewsData> {
        try await base.researchNews(symbol: symbol)
    }
    func researchWatchlist() async throws -> ResearchWatchlistPage { try await base.researchWatchlist() }
    func researchCreateWatchlist(_ input: TaxValue) async throws -> ResearchWatchlistItem {
        try await base.researchCreateWatchlist(input)
    }
    func researchUpdateWatchlist(id: Int, input: TaxValue) async throws -> ResearchWatchlistItem {
        try await base.researchUpdateWatchlist(id: id, input: input)
    }
    func researchDeleteWatchlist(id: Int) async throws { try await base.researchDeleteWatchlist(id: id) }
    func researchInvestments() async throws -> [PortfolioInvestment] { try await base.researchInvestments() }
    func researchPortfolioSummary(currency: String) async throws -> PortfolioSummaryData {
        try await base.researchPortfolioSummary(currency: currency)
    }
    func researchPriceHistory(id: Int, fromMs: Decimal, dbOnly: Bool) async throws -> ResearchPriceHistoryData {
        try await base.researchPriceHistory(id: id, fromMs: fromMs, dbOnly: dbOnly)
    }
    func researchMappings(instrumentKey: String, keyType: String) async throws -> ResearchSnapshot<ResearchMappingsData> {
        try await base.researchMappings(instrumentKey: instrumentKey, keyType: keyType)
    }
    func researchResolveMappings(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchMappingResolveData> {
        try await base.researchResolveMappings(input)
    }
    func researchSaveMappings(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchMappingsData> {
        try await base.researchSaveMappings(input)
    }
    func researchDeleteMapping(id: Int) async throws { try await base.researchDeleteMapping(id: id) }
    func researchAuditMappings(_ input: TaxValue) async throws -> ResearchSnapshot<ResearchMappingAuditData> {
        try await base.researchAuditMappings(input)
    }
    func researchCreateInvestment(_ input: TaxValue) async throws -> PortfolioInvestment {
        try await base.researchCreateInvestment(input)
    }
    func researchCreateTransaction(investmentId: Int, input: TaxValue) async throws -> PortfolioTransaction {
        try await base.researchCreateTransaction(investmentId: investmentId, input: input)
    }
    func researchPresentation(_ input: TaxValue) async throws -> TaxValue { try await presentation(input) }
}
