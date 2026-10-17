import Foundation

public enum StatisticsWindow: String, Sendable, CaseIterable {
    case rolling24 = "24m"
    case all

    public func queryItems(now: Date, calendar: Calendar, includeAllTime: Bool = false) -> [URLQueryItem] {
        if self == .all { return includeAllTime ? [URLQueryItem(name: "all_time", value: "true")] : [] }
        let startOfMonth = calendar.date(from: calendar.dateComponents([.year, .month], from: now)) ?? now
        let start = calendar.date(byAdding: .month, value: -23, to: startOfMonth) ?? startOfMonth
        return [
            URLQueryItem(name: "start_date", value: Self.day(start, calendar: calendar)),
            URLQueryItem(name: "end_date", value: Self.day(now, calendar: calendar)),
        ]
    }
    public static func day(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}

/// `formatPeriodLabel` and `formatPeriodShort` (features/statistics/statisticsUtils.ts): a
/// `YYYY-MM` period as `MMM yyyy` or `MMM yy` in the app language; anything else unchanged.
public enum StatisticsPeriodFormat {
    public static func label(_ period: String, locale: Locale) -> String {
        format(period, pattern: "MMM yyyy", locale: locale)
    }
    public static func short(_ period: String, locale: Locale) -> String {
        format(period, pattern: "MMM yy", locale: locale)
    }
    private static func format(_ period: String, pattern: String, locale: Locale) -> String {
        let parts = period.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 4, parts[1].count == 2, let year = Int(parts[0]),
            let month = Int(parts[1]), (1...12).contains(month)
        else { return period }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        guard let date = calendar.date(from: DateComponents(year: year, month: month, day: 1)) else { return period }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }
}

public enum StatisticsTab: String, CaseIterable, Sendable {
    case overview, categories, recipients, yearly, flow, custom
    public var labelKey: String { self == .custom ? "customChart.tab" : "statsPage.tab.\(rawValue)" }
}

public enum StatisticsMetric: String, CaseIterable, Sendable {
    case absolute, income, expense, net
    public var transactionType: String? {
        switch self {
        case .income: return "income"
        case .expense: return "expense"
        default: return nil
        }
    }
}

public struct StatisticsCategoryPivot: Decodable, Equatable, Sendable {
    public struct Item: Decodable, Equatable, Sendable {
        public let categoryId: Int?
        public let categoryName: String
        public let categoryPathIds: [Int]?
        public let categoryPathSegments: [String]?
        public let total: Decimal
        public let income: Decimal?
        public let expense: Decimal?
        public let transactionCount: Int
        public let incomeByOwner: [String: Decimal]?
        public func amount(for metric: StatisticsMetric) -> Decimal {
            switch metric {
            case .absolute: return abs(total)
            case .net: return total
            case .income: return income ?? max(total, 0)
            case .expense: return expense.map { abs($0) } ?? max(-total, 0)
            }
        }
    }
    public let categoryPivot: [String: [Item]]
}

public struct StatisticsRecipientInsights: Decodable, Equatable, Sendable {
    public struct Merchant: Decodable, Equatable, Sendable, Identifiable {
        public let recipientId: Int
        public let name: String
        public let totalSpend: Decimal
        public let transactionCount: Int
        public let avgAmount: Decimal
        public let firstSeen: String
        public let lastSeen: String
        public var id: Int { recipientId }
        public static let tableKeys = ["name", "totalSpend", "transactionCount", "avgAmount", "firstSeen", "lastSeen"]
        public func rawValue(_ key: String) -> TableRawValue {
            switch key {
            case "name": return .text(name)
            case "totalSpend": return .number(totalSpend)
            case "transactionCount": return .number(Decimal(transactionCount))
            case "avgAmount": return .number(avgAmount)
            case "firstSeen": return .text(firstSeen)
            case "lastSeen": return .text(lastSeen)
            default: return .none
            }
        }
    }
    public struct Change: Decodable, Equatable, Sendable, Identifiable {
        public let recipientId: Int
        public let name: String
        public let currentSpend: Decimal
        public let previousSpend: Decimal
        public let changePercent: Decimal
        public var id: Int { recipientId }
    }
    public let topMerchants: [Merchant]
    public let monthOverMonth: [Change]
}

public struct StatisticsRecipientYears: Decodable, Equatable, Sendable {
    public struct Merchant: Decodable, Equatable, Sendable, Identifiable {
        public let recipientId: Int
        public let name: String
        public let totalSpend: Decimal
        public let transactionCount: Int
        public var id: Int { recipientId }
    }
    public let recipientsByYear: [String: [Merchant]]
}

public struct StatisticsFlow: Decodable, Equatable, Sendable {
    public struct Node: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let value: Decimal
    }
    public struct Link: Decodable, Equatable, Sendable, Identifiable {
        public let source: String
        public let target: String
        public let value: Decimal
        public var id: String { source + "→" + target }
    }
    public let nodes: [Node]
    public let links: [Link]
    public let year: Int
}

public struct StatisticsYear: Equatable, Sendable, Identifiable {
    public let year: Int
    public let income: Decimal
    public let spending: Decimal
    public let count: Int
    public var net: Decimal { income - spending }
    public var id: Int { year }
}

/// One category or ancestor row of the pivot, including amounts directly assigned to an
/// ancestor. Ordered path segments take precedence over the legacy GENERAL:DETAIL label.
public struct StatisticsCategory: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let categoryIds: [Int]
    public let path: [String]
    public let pathIds: [Int]
    public let values: [String: Decimal]
    public let incomeByOwner: [String: [String: Decimal]]
    public var total: Decimal { values.values.reduce(0, +) }
}

public struct StatisticsCategoryGroup: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let categoryIds: [Int]
    public let values: [String: Decimal]
    public let children: [StatisticsCategory]
    public var total: Decimal { values.values.reduce(0, +) }
    public var isExpandable: Bool { children.contains { $0.path.count > 1 } }
}

public struct StatisticsSnapshot: Equatable, Sendable {
    public let monthly: InsightMonthlySummary
    public let pivot: StatisticsCategoryPivot
    public let recipients: StatisticsRecipientInsights
    public let recipientYears: StatisticsRecipientYears
    public init(
        monthly: InsightMonthlySummary, pivot: StatisticsCategoryPivot,
        recipients: StatisticsRecipientInsights, recipientYears: StatisticsRecipientYears
    ) {
        self.monthly = monthly
        self.pivot = pivot
        self.recipients = recipients
        self.recipientYears = recipientYears
    }
    public var periods: [String] { monthly.orderedMonths.map(\.id) }
    public var years: [StatisticsYear] {
        Dictionary(grouping: monthly.months, by: \.year).map { year, months in
            StatisticsYear(
                year: year, income: months.reduce(0) { $0 + $1.total_income },
                spending: months.reduce(0) { $0 + abs($1.total_spending) },
                count: months.reduce(0) { $0 + $1.transaction_count })
        }.sorted { $0.year < $1.year }
    }
    public var totalIncome: Decimal { monthly.months.reduce(0) { $0 + $1.total_income } }
    public var totalSpending: Decimal { monthly.months.reduce(0) { $0 + abs($1.total_spending) } }
    public var averageSpending: Decimal { totalSpending / Decimal(max(1, monthly.months.count)) }

    public func categories(metric: StatisticsMetric, periods: Set<String>? = nil) -> [StatisticsCategory] {
        let entries = pivot.categoryPivot.filter { periods == nil || periods!.contains($0.key) }
        var rows: [String: StatisticsCategory] = [:]
        for (period, items) in entries {
            for item in items {
                let id = item.categoryId.map(String.init) ?? "null"
                let old = rows[id]
                var values = old?.values ?? [:]
                values[period, default: 0] += item.amount(for: metric)
                var ownerAmounts = old?.incomeByOwner ?? [:]
                if let owner = item.incomeByOwner { ownerAmounts[period] = owner }
                let path =
                    item.categoryPathSegments.flatMap { $0.isEmpty ? nil : $0 }
                    ?? item.categoryName.split(separator: ":", maxSplits: 1).map {
                        String($0).trimmingCharacters(in: .whitespaces)
                    }
                rows[id] = StatisticsCategory(
                    id: id, name: item.categoryName, categoryIds: item.categoryId.map { [$0] } ?? [],
                    path: path, pathIds: item.categoryPathIds ?? [], values: values, incomeByOwner: ownerAmounts)
            }
        }
        return rows.values.sorted { $0.total == $1.total ? $0.id < $1.id : $0.total > $1.total }
    }

    public func categoryGroups(metric: StatisticsMetric, periods: Set<String>? = nil) -> [StatisticsCategoryGroup] {
        let rows = categories(metric: metric, periods: periods).filter { metric == .net ? $0.total != 0 : $0.total > 0 }
        return Dictionary(grouping: rows) { row in
            row.pathIds.first.map { "id:\($0)" } ?? "name:\(row.path.first ?? row.name)"
        }.map { key, children in
            var values: [String: Decimal] = [:]
            for child in children { for (period, value) in child.values { values[period, default: 0] += value } }
            var nested: [String: StatisticsCategory] = [:]
            for child in children where child.path.count > 1 {
                for depth in 2...child.path.count {
                    let path = Array(child.path.prefix(depth))
                    let ids = Array(child.pathIds.prefix(depth))
                    let id = ids.count == depth ? "id:\(ids.last!)" : "path:\(path.joined(separator: "/"))"
                    let old = nested[id]
                    var amounts = old?.values ?? [:]
                    for (period, value) in child.values { amounts[period, default: 0] += value }
                    var owners = old?.incomeByOwner ?? [:]
                    for (period, ownerAmounts) in child.incomeByOwner {
                        for (owner, amount) in ownerAmounts {
                            owners[period, default: [:]][owner, default: 0] += amount
                        }
                    }
                    nested[id] = StatisticsCategory(
                        id: id, name: path.dropFirst().joined(separator: " / "),
                        categoryIds: Array(Set((old?.categoryIds ?? []) + child.categoryIds)).sorted(),
                        path: path, pathIds: ids, values: amounts, incomeByOwner: owners)
                }
            }
            return StatisticsCategoryGroup(
                id: key, name: children.first?.path.first ?? "",
                categoryIds: Array(Set(children.flatMap(\.categoryIds))).sorted(), values: values,
                children: nested.values.sorted { $0.path.lexicographicallyPrecedes($1.path) })
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    public func extremes(currentPeriod: String) -> (best: InsightMonth, worst: InsightMonth, positive: Int, count: Int)?
    {
        let complete = monthly.orderedMonths.filter { $0.id != currentPeriod }
        let pool = complete.isEmpty ? monthly.orderedMonths : complete
        let net: (InsightMonth) -> Decimal = { $0.total_income - abs($0.total_spending) }
        guard let first = pool.first else { return nil }
        var best = first
        var worst = first
        for month in pool {
            if net(month) > net(best) { best = month }
            if net(month) < net(worst) { worst = month }
        }
        return (best, worst, monthly.months.filter { net($0) >= 0 }.count, monthly.months.count)
    }
}

extension InsightWidget {
    public static let statistics: [InsightWidget] = [
        InsightWidget("summaryCards", "statsPage.widget.monthlyRhythm"),
        InsightWidget("monthly", "statsPage.widget.monthly"), InsightWidget("netTrend", "statsPage.widget.netTrend"),
        InsightWidget("categoryPie", "statsPage.widget.categoryPie"),
        InsightWidget("categoryTrend", "statsPage.widget.categoryTrend"),
        InsightWidget("pivotTable", "statsPage.widget.pivotTable"),
        InsightWidget("topRecipients", "statsPage.widget.topRecipients"),
        InsightWidget("yearlyComparison", "statsPage.widget.yearlyComparison"),
        InsightWidget("yearlySummary", "statsPage.widget.yearlySummary"),
    ]
}
