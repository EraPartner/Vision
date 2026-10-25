import Foundation

public struct ResearchForecastBands: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let p10: Decimal
    public let p25: Decimal
    public let p50: Decimal
    public let p75: Decimal
    public let p90: Decimal
    public let mean: Decimal?
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        p10 = try ResearchDecode.decimal(raw["p10"])
        p25 = try ResearchDecode.decimal(raw["p25"])
        p50 = try ResearchDecode.decimal(raw["p50"])
        p75 = try ResearchDecode.decimal(raw["p75"])
        p90 = try ResearchDecode.decimal(raw["p90"])
        mean = try ResearchDecode.optionalDecimal(raw["mean"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct ResearchForecastPoint: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let monthIndex: Int
    public let date: String
    public let netInvested: Decimal
    public let bands: ResearchForecastBands
    public var id: Int { monthIndex }
    public var p10: Decimal { bands.p10 }
    public var p25: Decimal { bands.p25 }
    public var p50: Decimal { bands.p50 }
    public var p75: Decimal { bands.p75 }
    public var p90: Decimal { bands.p90 }
    public init(raw: TaxValue) throws {
        self.raw = raw
        monthIndex = try ResearchDecode.count(raw["monthIndex"])
        date = try ResearchDecode.string(raw["date"])
        netInvested = try ResearchDecode.decimal(raw["netInvested"])
        bands = try .init(raw: raw)
        guard monthIndex > 0 else { throw ResearchDecode.failure("Invalid forecast month") }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct ResearchForecastForwardHolding: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let symbol: String
    public let expectedAnnual: Decimal
    public let growth: Decimal
    public let dividendYield: Decimal?
    public var id: String { symbol }
    public init(raw: TaxValue) throws {
        self.raw = raw
        symbol = try ResearchDecode.string(raw["symbol"])
        expectedAnnual = try ResearchDecode.decimal(raw["expectedAnnual"])
        growth = try ResearchDecode.decimal(raw["growth"])
        dividendYield = try raw["dividendYield"].map { try ResearchDecode.decimal($0) }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
/// Authoritative portfolioProjection response. Unavailable responses carry no invented amounts.
public struct ResearchForecastData: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let available: Bool
    public let reason: String?
    public let historyDays: Int?
    public let points: [ResearchForecastPoint]
    public let projected: ResearchForecastBands?
    public let forwardHoldings: [ResearchForecastForwardHolding]
    public var currency: String? { raw["currency"]?.stringValue }
    public var method: String? { raw["method"]?.stringValue }
    public var seed: String? { raw["seed"]?.stringValue }
    public var horizonMonths: Int? { raw["horizonMonths"]?.decimalValue.map { NSDecimalNumber(decimal: $0).intValue } }
    public var paths: Int? { raw["paths"]?.decimalValue.map { NSDecimalNumber(decimal: $0).intValue } }
    public var goalMonth: Int? { raw["goalMonth"]?.decimalValue.map { NSDecimalNumber(decimal: $0).intValue } }
    public var lowConfidence: Bool { raw["lowConfidence"]?.boolValue ?? false }
    public var usedForward: Bool { raw["usedForward"]?.boolValue ?? false }
    public var startValue: Decimal? { raw["startValue"]?.decimalValue }
    public var startInvested: Decimal? { raw["startInvested"]?.decimalValue }
    public var monthlyContribution: Decimal? { raw["monthlyContribution"]?.decimalValue }
    public var totalContributions: Decimal? { raw["totalContributions"]?.decimalValue }
    public var netInvested: Decimal? { raw["netInvested"]?.decimalValue }
    public var expectedAnnualReturn: Decimal? { raw["expectedAnnualReturn"]?.decimalValue }
    public var historicalAnnualReturn: Decimal? { raw["historicalAnnualReturn"]?.decimalValue }
    public var annualVolatility: Decimal? { raw["annualVolatility"]?.decimalValue }
    public var forwardBlend: Decimal? { raw["forwardBlend"]?.decimalValue }
    public var probBelowInvested: Decimal? { raw["probBelowInvested"]?.decimalValue }
    public var targetValue: Decimal? { raw["targetValue"]?.decimalValue }
    public var probTarget: Decimal? { raw["probTarget"]?.decimalValue }
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        available = try ResearchDecode.bool(raw["available"])
        reason = try ResearchDecode.optionalString(raw["reason"])
        historyDays = try raw["historyDays"].map { try ResearchDecode.count($0) }
        if available {
            _ = try ResearchDecode.count(raw["historyDays"])
            for key in [
                "startValue", "startInvested", "monthlyContribution", "totalContributions", "netInvested",
                "expectedAnnualReturn", "historicalAnnualReturn", "annualVolatility", "forwardBlend",
                "probBelowInvested",
            ] {
                _ = try ResearchDecode.decimal(raw[key])
            }
            for key in ["horizonMonths", "paths", "flowArtifactDays"] { _ = try ResearchDecode.count(raw[key]) }
            for key in ["currency", "method", "seed"] { _ = try ResearchDecode.string(raw[key]) }
            for key in ["lowConfidence", "usedForward"] { _ = try ResearchDecode.bool(raw[key]) }
            for key in ["targetValue", "probTarget"] {
                if let value = raw[key] { _ = try ResearchDecode.decimal(value) }
            }
            if let goal = raw["goalMonth"] {
                guard try ResearchDecode.count(goal) > 0 else {
                    throw ResearchDecode.failure("Invalid forecast goal month")
                }
            }
            projected = try ResearchDecode.required(raw["projected"], ResearchForecastBands.self)
            guard projected?.mean != nil, ["parametric", "block_bootstrap"].contains(raw["method"]?.stringValue ?? ""),
                try ResearchDecode.count(raw["horizonMonths"]) > 0, try ResearchDecode.count(raw["paths"]) > 0
            else {
                throw ResearchDecode.failure("Invalid available forecast metadata or projected mean")
            }
            points = try ResearchDecode.required(raw["points"], [ResearchForecastPoint].self)
            forwardHoldings = try ResearchDecode.required(raw["forwardHoldings"], [ResearchForecastForwardHolding].self)
            guard Set(points.map(\.id)).count == points.count else {
                throw ResearchDecode.failure("Duplicate forecast months")
            }
        } else {
            guard ["no_holdings", "insufficient_history"].contains(reason) else {
                throw ResearchDecode.failure("Unknown forecast unavailable reason")
            }
            projected = nil
            points = []
            forwardHoldings = []
        }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
