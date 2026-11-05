import Foundation

/// Where the forecast's expected return comes from (`forwardBlend` is zero for `historical`).
public enum ResearchForecastReturnSource: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case historical
    case blended
    case unknown(String)

    public static var allCases: [ResearchForecastReturnSource] { [.historical, .blended] }

    private static let known: [String: Self] = ["historical": .historical, "blended": .blended]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .historical: return "historical"
        case .blended: return "blended"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// The Monte Carlo method of a forecast (`ForecastRequest.method`).
public enum ResearchForecastMethod: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case parametric
    case blockBootstrap
    case unknown(String)

    public static var allCases: [ResearchForecastMethod] { [.parametric, .blockBootstrap] }

    private static let known: [String: Self] = ["parametric": .parametric, "block_bootstrap": .blockBootstrap]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .parametric: return "parametric"
        case .blockBootstrap: return "block_bootstrap"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: any Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
