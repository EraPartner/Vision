import Foundation

public struct StatisticsQuery: Equatable, Sendable {
    public let currency: String
    public let window: StatisticsWindow
    public let exclusions: InsightExclusions
    public let today: Date
    public let calendar: Calendar
    public init(
        currency: String, window: StatisticsWindow, exclusions: InsightExclusions,
        today: Date, calendar: Calendar
    ) {
        self.currency = currency
        self.window = window
        self.exclusions = exclusions
        self.today = today
        self.calendar = calendar
    }
    public func queryItems(includeAllTime: Bool = false) -> [URLQueryItem] {
        [URLQueryItem(name: "currency", value: currency)] + exclusions.queryItems
            + window.queryItems(now: today, calendar: calendar, includeAllTime: includeAllTime)
    }
    public var unfiltered: StatisticsQuery {
        StatisticsQuery(
            currency: currency, window: window, exclusions: InsightExclusions(), today: today, calendar: calendar)
    }
}

public protocol StatisticsService: HomeService {
    func statisticsMonthly(_ query: StatisticsQuery) async throws -> InsightMonthlySummary
    func statisticsCategories(_ query: StatisticsQuery) async throws -> StatisticsCategoryPivot
    func statisticsRecipients(_ query: StatisticsQuery) async throws -> StatisticsRecipientInsights
    func statisticsRecipientYears(_ query: StatisticsQuery) async throws -> StatisticsRecipientYears
    func statisticsFlow(currency: String, year: Int, exclusions: InsightExclusions) async throws -> StatisticsFlow
}

extension StatisticsService {
    public func statisticsSnapshot(_ query: StatisticsQuery) async throws -> StatisticsSnapshot {
        async let monthly = statisticsMonthly(query)
        async let categories = statisticsCategories(query)
        async let recipients = statisticsRecipients(query)
        async let years = statisticsRecipientYears(query)
        return try await StatisticsSnapshot(
            monthly: monthly, pivot: categories, recipients: recipients, recipientYears: years)
    }
}

extension APIClient: StatisticsService {
    public func statisticsMonthly(_ query: StatisticsQuery) async throws -> InsightMonthlySummary {
        try await send(
            InsightRequest<OpenAPIOperations.GetMonthlySummary, InsightMonthlySummary>(
                OpenAPIOperations.GetMonthlySummary(), query: query.queryItems(includeAllTime: true)))
    }
    public func statisticsCategories(_ query: StatisticsQuery) async throws -> StatisticsCategoryPivot {
        try await send(
            InsightRequest<OpenAPIOperations.GetCategoryPivot, StatisticsCategoryPivot>(
                OpenAPIOperations.GetCategoryPivot(), query: query.queryItems()))
    }
    public func statisticsRecipients(_ query: StatisticsQuery) async throws -> StatisticsRecipientInsights {
        try await send(
            InsightRequest<OpenAPIOperations.GetRecipientInsights, StatisticsRecipientInsights>(
                OpenAPIOperations.GetRecipientInsights(), query: query.queryItems()))
    }
    public func statisticsRecipientYears(_ query: StatisticsQuery) async throws -> StatisticsRecipientYears {
        try await send(
            InsightRequest<OpenAPIOperations.GetRecipientByYear, StatisticsRecipientYears>(
                OpenAPIOperations.GetRecipientByYear(), query: query.queryItems()))
    }
    public func statisticsFlow(currency: String, year: Int, exclusions: InsightExclusions) async throws
        -> StatisticsFlow
    {
        try await send(
            InsightRequest<OpenAPIOperations.GetSankey, StatisticsFlow>(
                OpenAPIOperations.GetSankey(),
                query: [
                    URLQueryItem(name: "currency", value: currency),
                    URLQueryItem(name: "year", value: String(year)),
                ] + exclusions.queryItems))
    }
}
