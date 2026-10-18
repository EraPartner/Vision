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
        guard let days, let last = snapshots.last, let parts = NetWorthDay.parts(last.date),
            let anchor = calendar.date(from: DateComponents(year: parts.year, month: parts.month, day: parts.day)),
            let cutoff = calendar.date(byAdding: .day, value: -days, to: anchor)
        else { return snapshots }
        let key = StatisticsWindow.day(cutoff, calendar: calendar)
        return snapshots.filter { $0.date >= key }
    }
}

enum NetWorthDay {
    static func parts(_ text: String) -> (year: Int, month: Int, day: Int)? {
        let value = String(text.prefix(10))
        let pieces = value.split(separator: "-", omittingEmptySubsequences: false)
        guard pieces.count == 3, pieces[0].count == 4, pieces[1].count == 2, pieces[2].count == 2,
            let year = Int(pieces[0]), let month = Int(pieces[1]), let day = Int(pieces[2]),
            DateComponents(year: year, month: month, day: day).isValidDate(in: Calendar(identifier: .gregorian))
        else { return nil }
        return (year, month, day)
    }
}

public struct NetWorthTableRow: Identifiable, Equatable, Sendable {
    public let snapshot: OpenAPI.NetWorthSnapshot
    public let change: Decimal?
    public var id: String { snapshot.date }
    public func rawValue(_ key: String) -> TableRawValue {
        switch key {
        case "date": .text(snapshot.date)
        case "liquid": .number(snapshot.liquid)
        case "liabilities": .number(snapshot.liabilities)
        case "investments": .number(snapshot.investments)
        case "netWorth": .number(snapshot.netWorth)
        case "change": change.map(TableRawValue.number) ?? .none
        default: .none
        }
    }
}

public struct NetWorthAccountRow: Identifiable, Equatable, Sendable {
    public let accountId: Int?
    public let label: String?
    public let type: String?
    public let cash: Decimal
    public let holdings: Decimal
    public var total: Decimal { Self.cents(cash + holdings) }
    public var id: String { accountId.map { "account-\($0)" } ?? "unassigned" }
    public static func build(
        accounts: [OpenAPI.Account], partitions: NetWorthPartitions, rates: OpenAPI.ExchangeRates, currency: String
    ) throws -> [Self] {
        guard partitions.currency == currency else {
            throw APIError.invalidRequest("Wrong portfolio breakdown currency")
        }
        var byCurrency = rates.fallbackRates
        byCurrency["EUR"] = 1
        for rate in rates.rates { byCurrency[rate.currency] = rate.rateToEur }
        var values: [String: (Int?, Decimal, Decimal)] = [:]
        for account in accounts where account.inNetWorth {
            var cash: Decimal = 0
            if !["crypto_exchange", "wallet"].contains(account.type) {
                let amount = account.computedBalance ?? 0
                if account.currency == currency {
                    cash = amount
                } else {
                    guard let from = byCurrency[account.currency], from > 0, let target = byCurrency[currency],
                        target > 0
                    else {
                        throw APIError.invalidRequest("Unavailable exchange rate for net worth breakdown")
                    }
                    cash = amount * from / target
                }
            }
            values["account-\(account.id)"] = (account.id, cash, 0)
        }
        for partition in partitions.byAccount {
            let key = partition.accountId.map { "account-\($0)" } ?? "unassigned"
            let previous = values[key] ?? (partition.accountId, 0, 0)
            values[key] = (previous.0, previous.1, previous.2 + partition.currentValue)
        }
        return values.values.map { id, cash, holdings in
            let account = accounts.first { $0.id == id }
            return Self(
                accountId: id,
                label: account.map { $0.displayName.flatMap { $0.isEmpty ? nil : $0 } ?? $0.name }
                    ?? id.map { "#\($0)" }, type: account?.type, cash: cents(cash), holdings: cents(holdings))
        }.sorted { left, right in
            if left.accountId == nil { return false }
            if right.accountId == nil { return true }
            return (left.label ?? "").localizedStandardCompare(right.label ?? "") == .orderedAscending
        }
    }
    public static func cents(_ value: Decimal) -> Decimal {
        var input = value
        var result = Decimal()
        NSDecimalRound(&result, &input, 2, .plain)
        return result
    }
}

public struct NetWorthPartitions: Decodable, Equatable, Sendable {
    public let currency: String
    public let byAccount: [Partition]
    public struct Partition: Decodable, Equatable, Sendable {
        public let accountId: Int?
        public let currentValue: Decimal
        enum CodingKeys: String, CodingKey {
            case accountId = "account_id"
            case currentValue
        }
    }
}

public struct NetWorthInvestmentPrice: Decodable, Equatable, Sendable {
    public let id: Int
    public let priceProvider: String?
    public let priceUpdatedAt: String?
    public let isActive: Bool
    public var isLive: Bool { isActive && (priceProvider ?? "manual") != "manual" }
    enum CodingKeys: String, CodingKey {
        case id
        case priceProvider = "price_provider"
        case priceUpdatedAt = "price_updated_at"
        case isActive = "is_active"
    }
}
