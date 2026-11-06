import Foundation

public enum NetWorthPeriod: String, CaseIterable, Sendable {
    case month = "1m"
    case quarter = "3m"
    case halfYear = "6m"
    case year = "1y"
    case threeYears = "3y"
    case all
    public init(route: NativeRoute) { self = Self(rawValue: route.value("period") ?? "") ?? .year }
    public var days: Int? {
        switch self {
        case .month: 30
        case .quarter: 90
        case .halfYear: 180
        case .year: 365
        case .threeYears: 1095
        case .all: nil
        }
    }
    public static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }
    public func filter(_ snapshots: [OpenAPI.NetWorthSnapshot], calendar: Calendar = Self.calendar) -> [OpenAPI
        .NetWorthSnapshot]
    {
        guard let days, let last = snapshots.last,
            let anchor = last.date.date(in: calendar),
            let cutoff = calendar.date(byAdding: .day, value: -days, to: anchor)
        else { return snapshots }
        let key = StatisticsWindow.day(cutoff, calendar: calendar)
        return snapshots.filter { $0.date.description >= key }
    }
}

/// A column of the net worth history table, and (bar `date` and `change`) a chart series. The raw
/// value is the web app's column key, used by the table query and the series ids.
public enum NetWorthColumn: String, CaseIterable, Sendable {
    case date, liquid, investments, liabilities, netWorth, change

    /// The localisation key of the table header.
    public var titleKey: String { self == .netWorth ? "networth.title" : "networth." + rawValue }
    /// The localisation key of the chart series label.
    public var seriesLabelKey: String { self == .netWorth ? "networth.seriesTotal" : "networth." + rawValue }
    public var isLeading: Bool { self == .date }

    /// The snapshot's amount for a chart series; `nil` for `date` and `change`.
    public func amount(_ snapshot: OpenAPI.NetWorthSnapshot) -> Decimal? {
        switch self {
        case .liquid: snapshot.liquid
        case .investments: snapshot.investments
        case .liabilities: snapshot.liabilities
        case .netWorth: snapshot.netWorth
        case .date, .change: nil
        }
    }

    /// The liabilities column and series show only when some snapshot carries a debt.
    public static func hasLiabilities(_ snapshots: [OpenAPI.NetWorthSnapshot]) -> Bool {
        snapshots.contains { abs($0.liabilities) > Decimal.literal("0.005") }
    }

    /// The table columns, in the web app's order.
    public static func table(_ snapshots: [OpenAPI.NetWorthSnapshot]) -> [NetWorthColumn] {
        [.date, .liquid] + (hasLiabilities(snapshots) ? [.liabilities] : []) + [.investments, .netWorth, .change]
    }

    /// The chart series, in the web app's order.
    public static func series(_ snapshots: [OpenAPI.NetWorthSnapshot]) -> [NetWorthColumn] {
        [.liquid, .investments] + (hasLiabilities(snapshots) ? [.liabilities] : []) + [.netWorth]
    }
}

public struct NetWorthTableRow: Identifiable, Equatable, Sendable {
    public let snapshot: OpenAPI.NetWorthSnapshot
    public let change: Decimal?
    public var id: String { snapshot.date.description }
    public func rawValue(_ column: NetWorthColumn) -> TableRawValue {
        switch column {
        case .date: .text(snapshot.date.description)
        case .change: change.map(TableRawValue.number) ?? .none
        case .liquid, .investments, .liabilities, .netWorth:
            column.amount(snapshot).map(TableRawValue.number) ?? .none
        }
    }
    /// The table query's string column key.
    public func rawValue(_ key: String) -> TableRawValue {
        NetWorthColumn(rawValue: key).map(rawValue) ?? .none
    }
}

/// One row of `GET /api/info/net-worth/by-account`: the server converts the cash balance at the
/// stored rate and sums it with the live holdings (ADR-093, ADR-216). The client only labels and
/// orders the rows.
public struct NetWorthAccountRow: Identifiable, Equatable, Sendable {
    public let accountId: AccountID?
    public let label: String?
    public let type: String?
    public let cash: Decimal
    public let holdings: Decimal
    /// The server's `cash + holdings` for the row.
    public let total: Decimal
    public var id: String { accountId.map { "account-\($0)" } ?? "unassigned" }

    public init(accountId: AccountID?, label: String?, type: String?, cash: Decimal, holdings: Decimal, total: Decimal) {
        self.accountId = accountId
        self.label = label
        self.type = type
        self.cash = cash
        self.holdings = holdings
        self.total = total
    }

    /// The breakdown, or `nil` when a cash balance has no stored rate (`total == nil`): the
    /// breakdown is then unavailable rather than mixing currencies, as on the web. Rows sort by
    /// label with the unassigned holdings last.
    public static func rows(from response: OpenAPI.NetWorthByAccountResponse) -> (rows: [Self], total: Decimal)? {
        guard let total = response.total else { return nil }
        let rows = response.rows.map { row in
            Self(
                accountId: row.accountId,
                label: row.accountId.map { id in
                    let name = row.name ?? ""
                    return name.isEmpty ? "#\(id)" : name
                }, type: row.type, cash: row.cash ?? 0, holdings: row.holdings, total: row.total ?? 0)
        }.sorted { left, right in
            if left.accountId == nil { return false }
            if right.accountId == nil { return true }
            return (left.label ?? "").localizedStandardCompare(right.label ?? "") == .orderedAscending
        }
        return (rows, total)
    }

    public static func cents(_ value: Decimal) -> Decimal {
        var input = value
        var result = Decimal()
        NSDecimalRound(&result, &input, 2, .plain)
        return result
    }
}

public struct NetWorthInvestmentPrice: Decodable, Equatable, Sendable {
    public let id: InvestmentID
    public let priceProvider: OpenAPI.PriceProvider?
    public let priceUpdatedAt: String?
    public let isActive: Bool
    public var isLive: Bool { isActive && (priceProvider ?? .manual) != .manual }
    enum CodingKeys: String, CodingKey {
        case id
        case priceProvider = "price_provider"
        case priceUpdatedAt = "price_updated_at"
        case isActive = "is_active"
    }
}
