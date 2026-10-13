import Foundation

/// Specializes the OpenAPI operation's untyped aggregation data without changing its
/// endpoint or the API client's envelope, authorization, retry, or error behavior.
public struct InsightRequest<Operation: APIOperation, Value: Decodable & Sendable>: APIOperation {
    public typealias Response = Value
    public static var operationId: String { Operation.operationId }
    public static var method: HTTPMethod { Operation.method }
    public static var pathTemplate: String { Operation.pathTemplate }
    public let operation: Operation
    public let queryItems: [URLQueryItem]
    public let bodyOverride: Data?
    public var path: String { operation.path }
    public var contentType: String { operation.contentType }
    public func encodedBody() throws -> Data? {
        if let bodyOverride { return bodyOverride }
        return try operation.encodedBody()
    }
    public init(_ operation: Operation, query: [URLQueryItem], bodyOverride: Data? = nil) {
        self.operation = operation
        self.queryItems = query
        self.bodyOverride = bodyOverride
    }
}

public protocol HomeService: Sendable {
    func homeMonthly(currency: String, exclusions: InsightExclusions) async throws
        -> InsightMonthlySummary
    func homePace(currency: String) async throws -> HomeSpendingPace
    func homeBalances(currency: String) async throws -> HomeBankBalances
    func homeNetWorth(currency: String) async throws -> HomeNetWorth
    func homeForecast(
        currency: String, exclusions: InsightExclusions, options: InsightForecastOptions
    ) async throws -> InsightForecast
    func homeForecastAccuracy() async throws -> InsightForecastAccuracy
    func homeTransactionCount() async throws -> Int
    func homeNeedsCategory() async throws -> Int
    func homeTransactions(offset: Int, limit: Int) async throws -> HomeTransactionPage
    func homeAccounts() async throws -> [OpenAPI.Account]
    func homePlanned(start: String, end: String, limit: Int) async throws -> [OpenAPI
        .PlannedTransaction]
    func homeMatchCount() async throws -> Int
    func homeExclusions(scope: String) async throws -> InsightExclusions
    func homeWidgetSetting() async throws -> OpenAPI.Setting
    func saveHomeWidgets(_ value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting
}

public struct HomeTransactionPage: Equatable, Sendable {
    public let items: [OpenAPI.Transaction]
    public let total: Int
    public init(items: [OpenAPI.Transaction], total: Int) {
        self.items = items
        self.total = total
    }
}

extension APIClient: HomeService {
    public func homeMonthly(currency: String, exclusions: InsightExclusions) async throws
        -> InsightMonthlySummary
    {
        try await send(
            InsightRequest<OpenAPIOperations.GetMonthlySummary, InsightMonthlySummary>(
                OpenAPIOperations.GetMonthlySummary(),
                query: currencyItems(currency) + exclusions.queryItems))
    }
    public func homePace(currency: String) async throws -> HomeSpendingPace {
        try await send(
            InsightRequest<OpenAPIOperations.GetAverageVsCurrent, HomeSpendingPace>(
                OpenAPIOperations.GetAverageVsCurrent(), query: currencyItems(currency)))
    }
    public func homeBalances(currency: String) async throws -> HomeBankBalances {
        try await send(
            InsightRequest<OpenAPIOperations.GetBankBalances, HomeBankBalances>(
                OpenAPIOperations.GetBankBalances(), query: currencyItems(currency)))
    }
    public func homeNetWorth(currency: String) async throws -> HomeNetWorth {
        try await send(
            InsightRequest<OpenAPIOperations.GetNetWorth, HomeNetWorth>(
                OpenAPIOperations.GetNetWorth(), query: currencyItems(currency)))
    }
    public func homeForecast(
        currency: String, exclusions: InsightExclusions, options: InsightForecastOptions
    ) async throws -> InsightForecast {
        let query = currencyItems(currency) + exclusions.queryItems + options.queryItems
        if options.mode == .month {
            return try await send(
                InsightRequest<OpenAPIOperations.GetCashflowForecastMethods, InsightForecast>(
                    OpenAPIOperations.GetCashflowForecastMethods(), query: query))
        }
        return try await send(
            InsightRequest<OpenAPIOperations.GetCashflowForecastRolling, InsightForecast>(
                OpenAPIOperations.GetCashflowForecastRolling(), query: query))
    }
    public func homeTransactionCount() async throws -> Int {
        let result = try await send(OpenAPIOperations.GetTransactionCount())
        guard let count = result["total_transactions"]?.intValue else {
            throw APIError.contract(
                APIContractError(
                    endpoint: "/api/info/transaction-count", issues: ["total_transactions: required integer"])
            )
        }
        return count
    }
    public func homeForecastAccuracy() async throws -> InsightForecastAccuracy {
        try await send(
            InsightRequest<OpenAPIOperations.GetCashflowForecastAccuracy, InsightForecastAccuracy>(
                OpenAPIOperations.GetCashflowForecastAccuracy(),
                query: [URLQueryItem(name: "limit_months", value: "24")]))
    }
    public func homeNeedsCategory() async throws -> Int {
        try await send(OpenAPIOperations.GetTransactions(limit: 1, active: true, uncategorised: true))
            .total
    }
    public func homeTransactions(offset: Int, limit: Int) async throws -> HomeTransactionPage {
        let page = try await send(OpenAPIOperations.GetTransactions(limit: limit, offset: offset))
        return HomeTransactionPage(items: page.items, total: page.total)
    }
    public func homeAccounts() async throws -> [OpenAPI.Account] {
        try await send(OpenAPIOperations.GetAccounts(active: "all")).items
    }
    public func homePlanned(start: String, end: String, limit: Int) async throws -> [OpenAPI
        .PlannedTransaction]
    {
        let operation = OpenAPIOperations.GetPlannedTransactions(limit: limit, active: true)
        return try await send(
            InsightRequest<
                OpenAPIOperations.GetPlannedTransactions, OpenAPIOperations.GetPlannedTransactions.Response
            >(
                operation,
                query: operation.queryItems + [
                    URLQueryItem(name: "start_date", value: start),
                    URLQueryItem(name: "end_date", value: end),
                ])
        ).items
    }
    public func homeMatchCount() async throws -> Int { try await matchSuggestions().count }
    public func homeExclusions(scope: String) async throws -> InsightExclusions {
        let value = try await setting(key: "dashboard_settings").value
        let exclusionScope = InsightExclusions.normalizedScope(value)
        if exclusionScope == "everywhere" || exclusionScope == scope {
            for key in ["excludedCategoryIds", "excludedRecipientIds"] {
                if let values = value[key]?.arrayValue,
                    values.allSatisfy({ item in
                        switch item {
                        case .int, .double: return true
                        default: return false
                        }
                    }),
                    values.contains(where: { $0.intValue == nil })
                {
                    throw APIError.invalidRequest("\(key): expected integer ids")
                }
            }
        }
        let needsHidden =
            (exclusionScope == "everywhere" || exclusionScope == scope)
            && (value["excludeHiddenCategories"]?.boolValue ?? true)
        var hidden: [Int] = []
        if needsHidden {
            async let tree = send(
                InsightRequest<OpenAPIOperations.GetCategoryTree, InsightCategoryTree>(
                    OpenAPIOperations.GetCategoryTree(), query: []))
            let operation = OpenAPIOperations.GetCategories(limit: 1000)
            async let legacy = send(
                InsightRequest<OpenAPIOperations.GetCategories, OpenAPIOperations.GetCategories.Response>(
                    operation, query: operation.queryItems + [URLQueryItem(name: "active", value: "false")]))
            hidden =
                try await tree.items.filter { !$0.isActive }.map(\.id)
                + legacy.items.filter { !$0.isActive }.map(\.id)
        }
        return InsightExclusions.resolve(settings: value, scope: scope, hiddenIds: hidden)
    }
    public func homeWidgetSetting() async throws -> OpenAPI.Setting {
        try await setting(key: "widget_visibility")
    }
    public func saveHomeWidgets(_ value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        try await saveSetting(key: "widget_visibility", value: value, expected: expected)
    }
    private func currencyItems(_ code: String) -> [URLQueryItem] {
        [URLQueryItem(name: "currency", value: code)]
    }
}

/// Required exclusion metadata: a malformed tree must never become an empty hidden-category list.
private struct InsightCategoryTree: Decodable, Sendable {
    let items: [OpenAPI.CategoryNode]
    let total: Int
}
