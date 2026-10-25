import Foundation

public enum RebalancePreset: String, CaseIterable, Sendable {
    case sixtyForty = "sixty_forty"
    case allWeather = "all_weather"
    case threeFund = "three_fund"
    case awesome
    /// Form defaults from RebalancePage, not an allocation algorithm. The server computes targets/deployment.
    public var weights: [(String, Decimal)] {
        switch self {
        case .sixtyForty: [("stocks", Decimal(string: "0.6")!), ("bonds", Decimal(string: "0.4")!)]
        case .allWeather:
            [
                ("stocks", Decimal(string: "0.3")!), ("bonds", Decimal(string: "0.55")!),
                ("gold", Decimal(string: "0.075")!), ("commodities", Decimal(string: "0.075")!),
            ]
        case .threeFund:
            [
                ("stocks", Decimal(string: "0.48")!), ("intl_stocks", Decimal(string: "0.12")!),
                ("bonds", Decimal(string: "0.4")!),
            ]
        case .awesome:
            [
                ("real_estate", Decimal(string: "0.2")!), ("stocks", Decimal(string: "0.2")!),
                ("gold", Decimal(string: "0.2")!), ("bonds", Decimal(string: "0.2")!),
                ("savings", Decimal(string: "0.2")!),
            ]
        }
    }
}

public struct RebalanceResult: Codable, Equatable, Sendable {
    public let currency: String
    public let targetWeights: [String: Decimal]
    public let actualValues: [String: Decimal]
    public let availableCash: Decimal
    public let cashAccounts: [CashAccount]
    public let deployment: [String: Decimal]
    public var sleeves: [String] { Set(actualValues.keys).union(targetWeights.keys).sorted() }
    public var totalDeployed: Decimal { deployment.values.reduce(0, +) }
    public init(
        currency: String, targetWeights: [String: Decimal], actualValues: [String: Decimal], availableCash: Decimal,
        cashAccounts: [CashAccount], deployment: [String: Decimal]
    ) {
        self.currency = currency
        self.targetWeights = targetWeights
        self.actualValues = actualValues
        self.availableCash = availableCash
        self.cashAccounts = cashAccounts
        self.deployment = deployment
    }
    public struct CashAccount: Codable, Equatable, Sendable {
        public let id: Int
        public let name: String
        public let accountCurrency: String
        /// Already converted. Never relabel this amount using accountCurrency.
        public let balance: Decimal
        public let balanceCurrency: String
        public init(id: Int, name: String, accountCurrency: String, balance: Decimal, balanceCurrency: String) {
            self.id = id
            self.name = name
            self.accountCurrency = accountCurrency
            self.balance = balance
            self.balanceCurrency = balanceCurrency
        }
    }
}

public struct RebalanceCashProjection: Codable, Equatable, Sendable {
    public let currency: String
    public let today: String
    public let horizonEnd: String
    public let horizonDays: Int
    public let currentCash: Decimal
    public let reserveFloor: Decimal
    public let minimumProjectedBalance: Decimal
    public let minimumDate: String
    public let candidateCashCap: Decimal
    public let occurrenceCount: Int
    public let assumptions: Assumptions
    public init(
        currency: String, today: String, horizonEnd: String, horizonDays: Int, currentCash: Decimal,
        reserveFloor: Decimal, minimumProjectedBalance: Decimal, minimumDate: String, candidateCashCap: Decimal,
        occurrenceCount: Int, assumptions: Assumptions
    ) {
        self.currency = currency
        self.today = today
        self.horizonEnd = horizonEnd
        self.horizonDays = horizonDays
        self.currentCash = currentCash
        self.reserveFloor = reserveFloor
        self.minimumProjectedBalance = minimumProjectedBalance
        self.minimumDate = minimumDate
        self.candidateCashCap = candidateCashCap
        self.occurrenceCount = occurrenceCount
        self.assumptions = assumptions
    }
    public struct Assumptions: Codable, Equatable, Sendable {
        public let plannedOnly: Bool
        public let excludesStatisticalForecast: Bool
        public let excludesFutureIncome: Bool
        public let excludesUnplannedExpenses: Bool
        public let currencyConversionAtRecentRates: Bool
        public init(
            plannedOnly: Bool, excludesStatisticalForecast: Bool, excludesFutureIncome: Bool,
            excludesUnplannedExpenses: Bool, currencyConversionAtRecentRates: Bool
        ) {
            self.plannedOnly = plannedOnly
            self.excludesStatisticalForecast = excludesStatisticalForecast
            self.excludesFutureIncome = excludesFutureIncome
            self.excludesUnplannedExpenses = excludesUnplannedExpenses
            self.currencyConversionAtRecentRates = currencyConversionAtRecentRates
        }
    }
}

public struct RebalanceRequest: Encodable, Equatable, Sendable {
    public let currency: String
    public let model: String?
    public let targetWeights: [String: Decimal]?
    public let availableCash: Decimal?
    public init(
        currency: String, model: RebalancePreset? = nil, targetWeights: [String: Decimal]? = nil,
        availableCash: Decimal? = nil
    ) {
        self.currency = currency
        self.model = model?.rawValue
        self.targetWeights = targetWeights
        self.availableCash = availableCash
    }
}

/// Known fields are editable while original unknown fields and numeric representations survive unrelated saves.
public struct RebalancePlan: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let targetWeights: [String: Decimal]
    public let cashCap: Decimal?
    public let storedValue: TaxValue
    public init(
        id: String, name: String, targetWeights: [String: Decimal], cashCap: Decimal? = nil, preserving: TaxValue? = nil
    ) {
        self.id = id
        self.name = name
        self.targetWeights = targetWeights
        self.cashCap = cashCap
        var value = preserving ?? .object([:])
        value["id"] = .string(id)
        value["name"] = .string(name)
        value["targetWeights"] = .object(targetWeights.mapValues(TaxValue.number))
        value["cashCap"] = cashCap.map(TaxValue.number)
        self.storedValue = value
    }
    public init(from decoder: any Decoder) throws {
        let value = try TaxValue(from: decoder)
        guard let id = value["id"]?.stringValue, !id.isEmpty,
            let name = value["name"]?.stringValue, !name.isEmpty,
            let rawWeights = value["targetWeights"]?.objectValue
        else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Invalid saved rebalance plan"))
        }
        var weights: [String: Decimal] = [:]
        for (key, raw) in rawWeights {
            guard let number = Self.number(raw), !number.isNaN, number >= 0 else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Invalid target weight"))
            }
            weights[key] = number
        }
        var cap: Decimal?
        if let raw = value["cashCap"] {
            guard let number = Self.number(raw), !number.isNaN, number >= 0 else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Invalid cash cap"))
            }
            cap = number
        }
        self.id = id
        self.name = name
        self.targetWeights = weights
        self.cashCap = cap
        self.storedValue = value
    }
    public func encode(to encoder: any Encoder) throws { try storedValue.encode(to: encoder) }
    private static func number(_ value: TaxValue) -> Decimal? {
        switch value {
        case .number(let number): number
        case .string(let text):
            text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? 0 : Decimal(string: text, locale: Locale(identifier: "en_US_POSIX"))
        case .bool(let value): value ? 1 : 0
        case .null: 0
        default: nil
        }
    }
}

public enum RebalanceForm {
    public static func weights(_ rows: [RebalanceDraftRow], format: NumberFormat) -> [String: Decimal] {
        var result: [String: Decimal] = [:]
        for row in rows where !row.sleeve.isEmpty {
            guard let amount = LocaleNumber.parse(row.pct, format: format), amount > 0 else { continue }
            result[row.sleeve, default: 0] += amount / 100
        }
        return result
    }
    public static func cap(_ input: String, available: Decimal, format: NumberFormat) -> Decimal? {
        guard !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let number = LocaleNumber.parse(input, format: format)
        else { return nil }
        return max(0, min(number, available))
    }
    public static func rows(_ weights: [(String, Decimal)], format: NumberFormat) -> [RebalanceDraftRow] {
        let rows = weights.map { RebalanceDraftRow(sleeve: $0.0, pct: percentage($0.1, format: format)) }
        return rows.isEmpty ? [.init(sleeve: "stocks", pct: "")] : rows
    }
    public static func currentMix(_ actuals: [String: Decimal], format: NumberFormat) -> [RebalanceDraftRow] {
        let rows = actuals.filter { $0.value > 0 }.sorted { $0.key < $1.key }
        let total = rows.reduce(Decimal.zero) { $0 + $1.value }
        guard total > 0 else { return RebalanceURLDraft.defaults.rows }
        return self.rows(rows.map { ($0.key, $0.value / total) }, format: format)
    }
    private static func percentage(_ fraction: Decimal, format: NumberFormat) -> String {
        var amount = fraction * 100
        var rounded = Decimal.zero
        NSDecimalRound(&rounded, &amount, 2, .plain)
        return LocaleNumber.editable(rounded, format: format)
    }
}
