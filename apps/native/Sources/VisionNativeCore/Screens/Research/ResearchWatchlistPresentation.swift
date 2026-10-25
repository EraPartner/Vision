import Foundation

/// All target comparisons and returns are delivered by the stateless TypeScript
/// presentation bridge. Native code only selects and formats its Decimal outputs.
public struct ResearchWatchlistMetrics: Decodable, Equatable, Sendable {
    public let distancePercent: Decimal?
    public let absoluteDistancePercent: Decimal?
    public let isAtOrBelowTarget: Bool
    public let sinceAddedPercent: Decimal?
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        distancePercent = try ResearchWatchlistPresentation.nullableNumber(raw, "distancePercent")
        absoluteDistancePercent = try ResearchWatchlistPresentation.nullableNumber(raw, "absoluteDistancePercent")
        isAtOrBelowTarget = try ResearchDecode.required(raw["isAtOrBelowTarget"], Bool.self)
        sinceAddedPercent = try ResearchWatchlistPresentation.nullableNumber(raw, "sinceAddedPercent")
    }
}

public struct ResearchWatchlistChartMetrics: Decodable, Equatable, Sendable {
    public let distancePercent: Decimal?
    public let absoluteDistancePercent: Decimal?
    public let isAtOrBelowTarget: Bool
    public let hasValidTarget: Bool
    public let domain: [Decimal]
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        distancePercent = try ResearchWatchlistPresentation.nullableNumber(raw, "distancePercent")
        absoluteDistancePercent = try ResearchWatchlistPresentation.nullableNumber(raw, "absoluteDistancePercent")
        isAtOrBelowTarget = try ResearchDecode.required(raw["isAtOrBelowTarget"], Bool.self)
        hasValidTarget = try ResearchDecode.required(raw["hasValidTarget"], Bool.self)
        guard let values = raw["domain"]?.arrayValue, values.count == 2 else {
            throw ResearchDecode.failure("Invalid watchlist chart domain")
        }
        domain = try values.map { try ResearchDecode.decimal($0) }
        guard domain[0] <= domain[1] else { throw ResearchDecode.failure("Invalid watchlist chart domain order") }
    }
}

public struct ResearchWatchlistPreview: Decodable, Equatable, Sendable {
    public let absolutePercent: Decimal
    public let direction: String
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        absolutePercent = try ResearchDecode.decimal(raw["absolutePercent"])
        direction = try ResearchDecode.string(raw["direction"])
        guard direction == "below" || direction == "above" else {
            throw ResearchDecode.failure("Invalid watchlist preview direction")
        }
    }
}

struct ResearchWatchlistPresentation: Decodable, Sendable {
    let list: ResearchWatchlistMetrics
    let chart: ResearchWatchlistChartMetrics
    let preview: ResearchWatchlistPreview?

    static func nullableNumber(_ raw: TaxValue, _ field: String) throws -> Decimal? {
        guard let value = raw[field] else { throw ResearchDecode.failure("Missing watchlist " + field) }
        return try ResearchDecode.optionalDecimal(value)
    }

    static func input(
        target: Decimal?, current: Decimal?, added: Decimal? = nil,
        points: [ResearchChartPoint] = []
    ) -> TaxValue {
        .object([
            "kind": .string("watchlist"),
            "targetPrice": target.map(TaxValue.number) ?? .null,
            "currentPrice": current.map(TaxValue.number) ?? .null,
            "addedPrice": added.map(TaxValue.number) ?? .null,
            "points": .array(
                points.map {
                    .object(["time": .number($0.time), "close": $0.close.map(TaxValue.number) ?? .null])
                }),
        ])
    }
}

public enum ResearchWatchlistRange: String, CaseIterable, Sendable {
    case month = "1mo"
    case threeMonths = "3mo"
    case sixMonths = "6mo"
    case year = "1y"
    case fiveYears = "5y"
    public var label: String {
        switch self {
        case .month: "1M"
        case .threeMonths: "3M"
        case .sixMonths: "6M"
        case .year: "1Y"
        case .fiveYears: "5Y"
        }
    }
    public var interval: String { self == .year ? "1wk" : self == .fiveYears ? "1mo" : "1d" }
}

public struct ResearchWatchlistPrefill: Equatable, Sendable {
    public let symbol: String
    public let name: String
    public let type: String?
    public let currency: String?
    public let price: Decimal?
    public init(symbol: String, name: String, type: String? = nil, currency: String? = nil, price: Decimal? = nil) {
        self.symbol = symbol
        self.name = name
        self.type = type
        self.currency = currency
        self.price = price
    }
}

public struct ResearchWatchlistAddDraft: Equatable, Sendable {
    public var assetClass = "stock"
    public var currency = "USD"
    public var targetPrice = ""
    public var notes = ""
    public init() {}
}

enum ResearchWatchlistInput {
    static let maximum: Decimal = 999_999_999_999
    static func price(_ input: String, format: NumberFormat) -> Decimal? {
        guard let value = LocaleNumber.parse(input, format: format), !value.isNaN, value > 0, value <= maximum else {
            return nil
        }
        return value
    }
    static func assetClass(_ type: String?) -> String {
        let type = type?.lowercased() ?? ""
        if type.contains("etf") { return "etf" }
        if type.contains("crypto") { return "crypto" }
        return "stock"
    }
}
