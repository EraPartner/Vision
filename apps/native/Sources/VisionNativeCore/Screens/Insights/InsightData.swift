import Foundation

/// Financial aggregates decode directly into Decimal, before any chart converts them to
/// coordinates. The TypeScript aggregation service remains the source of every total.
public struct InsightMonth: Decodable, Equatable, Sendable, Identifiable {
    public let month: Int
    public let year: Int
    public let period_start: String
    public let period_end: String
    public let total_spending: Decimal
    public let total_income: Decimal
    public let net_amount: Decimal
    public let transaction_count: Int
    public var id: String { String(format: "%04d-%02d", year, month) }
}

public struct InsightMonthlySummary: Decodable, Equatable, Sendable {
    public let months: [InsightMonth]
    /// Transactions left out of the figures for want of a stored rate (ADR-216).
    public let unconverted_count: Int?
    public var unconvertedCount: Int { unconverted_count ?? 0 }
    public var orderedMonths: [InsightMonth] { months.sorted { $0.id < $1.id } }
    public var latest: InsightMonth? { orderedMonths.last { $0.transaction_count > 0 } }
}

public struct InsightDailyAmount: Decodable, Equatable, Sendable {
    public let date: String
    public let spending: Decimal
    public let income: Decimal
}

public struct HomeSpendingPace: Decodable, Equatable, Sendable {
    public struct History: Decodable, Equatable, Sendable {
        public let avg_monthly_spending: Decimal
        public let months_counted: Int
    }
    public struct Current: Decodable, Equatable, Sendable {
        public let daily_data: [InsightDailyAmount]
        public let total_spending: Decimal
        public let days_elapsed: Int
        public let days_in_month: Int
    }
    public struct Comparison: Decodable, Equatable, Sendable {
        public let projected_monthly_total: Decimal
        public let avg_monthly_spending: Decimal
    }
    public let past_6_months: History
    public let current_month: Current
    public let comparison: Comparison
    /// Transactions left out of the figures for want of a stored rate (ADR-216).
    public let unconverted_count: Int?
    public var unconvertedCount: Int { unconverted_count ?? 0 }
    public var income: Decimal { current_month.daily_data.reduce(0) { $0 + $1.income } }

    /// Fill days without activity with zero, preserving the web hero's spending staircase.
    public var cumulativeSpending: [InsightChartPoint] {
        let daily = Dictionary(grouping: current_month.daily_data) { Int($0.date.suffix(2)) ?? 0 }
        var total: Decimal = 0
        return (0...max(1, current_month.days_elapsed)).map { day in
            total += daily[day, default: []].reduce(0) { $0 + $1.spending }
            return InsightChartPoint(key: String(day), value: total)
        }
    }
}

public struct InsightChartPoint: Equatable, Sendable, Identifiable {
    public let key: String
    public let value: Decimal
    public var id: String { key }
    public init(key: String, value: Decimal) {
        self.key = key
        self.value = value
    }
}

public struct HomeBankBalances: Decodable, Equatable, Sendable {
    public struct Account: Decodable, Equatable, Sendable, Identifiable {
        public let account_id: Int
        public let bank_account: String
        public let display_name: String?
        public let balance: Decimal
        public let drift: Decimal?
        public let anchor_date: String?
        public let post_anchor_count: Int?
        public let transaction_count: Int
        public let last_transaction: String
        public var id: Int { account_id }
        public var name: String { display_name.flatMap { $0.isEmpty ? nil : $0 } ?? bank_account }
    }
    public struct Point: Decodable, Equatable, Sendable {
        public let date: String
        public let balance: Decimal
    }
    public let accounts: [Account]
    public let total_net_position: Decimal
    public let history: [String: [Point]]
    public let total_history: [Point]
    /// Currency partitions left out for want of a stored rate (ADR-216).
    public let unconverted_count: Int?
    public var unconvertedCount: Int { unconverted_count ?? 0 }
}

public struct HomeNetWorth: Decodable, Equatable, Sendable {
    public struct Current: Decodable, Equatable, Sendable {
        public let liquid: Decimal
        public let liabilities: Decimal
        public let investments: Decimal
        public let netWorth: Decimal
    }
    public let current: Current
    public let monthlyChange: Decimal
    public let monthlyChangePercent: Decimal
    public let snapshots: [Snapshot]
    /// Currencies of balances left out because no stored rate converts them (ADR-216).
    public let unconvertedCurrencies: [String]?
    public struct Snapshot: Decodable, Equatable, Sendable {
        public let date: String
        public let netWorth: Decimal
    }
    public var assets: Decimal { current.liquid + current.investments }
    public var debt: Decimal { abs(current.liabilities) }
    public var hasData: Bool { assets != 0 || debt != 0 || !snapshots.isEmpty }
}

public struct InsightExclusions: Equatable, Sendable {
    public var categoryIds: [Int]
    public var recipientIds: [Int]
    public init(categoryIds: [Int] = [], recipientIds: [Int] = []) {
        self.categoryIds = Array(Set(categoryIds)).sorted()
        self.recipientIds = Array(Set(recipientIds)).sorted()
    }
    public var isEmpty: Bool { categoryIds.isEmpty && recipientIds.isEmpty }
    public var queryItems: [URLQueryItem] {
        categoryIds.map { URLQueryItem(name: "excluded_category_ids", value: String($0)) }
            + recipientIds.map { URLQueryItem(name: "excluded_recipient_ids", value: String($0)) }
    }
    public func includes(_ row: OpenAPI.Transaction) -> Bool {
        !(row.categoryId.map(categoryIds.contains) ?? false)
            && !(row.recipientId.map(recipientIds.contains) ?? false)
    }
    public static func resolve(settings: JSONValue?, scope: String, hiddenIds: [Int])
        -> InsightExclusions
    {
        let configuredScope = normalizedScope(settings)
        guard configuredScope == "everywhere" || configuredScope == scope else {
            return InsightExclusions()
        }
        let ids: (String) -> [Int] = { key in
            guard let values = settings?[key]?.arrayValue,
                values.allSatisfy({ value in
                    switch value {
                    case .int, .double: return true
                    default: return false
                    }
                })
            else { return [] }
            return values.compactMap(\.intValue)
        }
        let includeHidden = settings?["excludeHiddenCategories"]?.boolValue ?? true
        return InsightExclusions(
            categoryIds: ids("excludedCategoryIds") + (includeHidden ? hiddenIds : []),
            recipientIds: ids("excludedRecipientIds"))
    }
    public static func normalizedScope(_ settings: JSONValue?) -> String {
        let raw = settings?["exclusionScope"]?.stringValue ?? "everywhere"
        return ["everywhere", "dashboard", "statistics"].contains(raw) ? raw : "everywhere"
    }
}

public struct InsightWidget: Equatable, Sendable, Identifiable {
    public let id: String
    public let labelKey: String
    public let descriptionKey: String?
    public let defaultVisible: Bool
    public init(
        _ id: String, _ key: String, defaultVisible: Bool = true, descriptionKey: String? = nil
    ) {
        self.id = id
        self.labelKey = key
        self.defaultVisible = defaultVisible
        self.descriptionKey = descriptionKey
    }
    public static let home: [InsightWidget] = [
        InsightWidget("hero", "dashboard.hero"), InsightWidget("attention", "dashboard.attention"),
        InsightWidget("netWorth", "dashboard.netWorth"),
        InsightWidget("upcoming", "dashboard.upcoming"),
        InsightWidget("accounts", "dashboard.accounts"),
        InsightWidget("statCards", "dashboard.statCards", defaultVisible: false),
        InsightWidget("bankBalances", "dashboard.bankBalances", defaultVisible: false),
        InsightWidget("monthlyTrends", "dashboard.monthlyTrends"),
        InsightWidget("categoryPie", "dashboard.categoryDistribution"),
        InsightWidget("cashflowComparison", "dashboard.cashFlowComparison"),
        InsightWidget("recentTransactions", "dashboard.recentTransactions"),
    ]
}

/// Keeps unrelated pages and future widget ids when saving a single page's choices.
public struct InsightWidgetVisibility: Equatable, Sendable {
    public var pages: [String: JSONValue]
    public init(_ raw: JSONValue?) { pages = raw?.objectValue ?? [:] }
    public func isVisible(_ widget: InsightWidget, page: String) -> Bool {
        pages[page]?[widget.id]?.boolValue ?? widget.defaultVisible
    }
    public mutating func set(_ id: String, visible: Bool, page: String) {
        var values = pages[page]?.objectValue ?? [:]
        values[id] = .bool(visible)
        pages[page] = .object(values)
    }
    public mutating func reset(page: String) { pages.removeValue(forKey: page) }
    public var json: JSONValue { .object(pages) }
    /// useWidgetVisibility's read check: absent, or pages of boolean flags. Anything else is
    /// unknown saved data that must neither load nor be overwritten.
    public static func isValidSetting(_ raw: JSONValue) -> Bool {
        if raw == .null { return true }
        guard let pages = raw.objectValue else { return false }
        return pages.values.allSatisfy { page in
            page.objectValue.map { $0.values.allSatisfy { $0.boolValue != nil } } ?? false
        }
    }
}

/// Routes share the web URL contract; a drill keeps complete calendar-month boundaries.
public enum InsightsRoutes {
    public static let home = "/"
    public static let statistics = "/statistics"
    public static func drill(
        month: InsightMonth? = nil, type: String? = nil,
        categoryIds: [Int] = [], uncategorised: Bool = false, label: String? = nil
    ) -> NativeRoute {
        var query: [URLQueryItem] = []
        if let month {
            query += [
                URLQueryItem(name: "start_date", value: String(month.period_start.prefix(10))),
                URLQueryItem(name: "end_date", value: String(month.period_end.prefix(10))),
            ]
        }
        if let type { query.append(URLQueryItem(name: "transaction_type", value: type)) }
        if categoryIds.count == 1 {
            query.append(URLQueryItem(name: "category_id", value: String(categoryIds[0])))
        } else if !categoryIds.isEmpty {
            query.append(
                URLQueryItem(
                    name: "category_ids", value: categoryIds.map(String.init).joined(separator: ",")))
        }
        if uncategorised { query.append(URLQueryItem(name: "uncategorised", value: "true")) }
        if let label { query.append(URLQueryItem(name: "filter_label", value: label)) }
        return NativeRoute(path: "/transactions", query: query)
    }
}
