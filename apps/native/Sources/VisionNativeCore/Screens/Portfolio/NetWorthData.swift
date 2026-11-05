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

public struct NetWorthTableRow: Identifiable, Equatable, Sendable {
    public let snapshot: OpenAPI.NetWorthSnapshot
    public let change: Decimal?
    public var id: String { snapshot.date.description }
    public func rawValue(_ key: String) -> TableRawValue {
        switch key {
        case "date": .text(snapshot.date.description)
        case "liquid": .number(snapshot.liquid)
        case "liabilities": .number(snapshot.liabilities)
        case "investments": .number(snapshot.investments)
        case "netWorth": .number(snapshot.netWorth)
        case "change": change.map(TableRawValue.number) ?? .none
        default: .none
        }
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
