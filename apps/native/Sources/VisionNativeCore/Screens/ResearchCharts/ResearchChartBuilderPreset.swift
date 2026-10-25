import Foundation

/// A one-tap chart builder arrangement. A preset this client does not know changes nothing.
public enum ResearchChartBuilderPreset: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case priceVolume
    case sma
    case bollinger
    case rsi
    case macd
    case rebased
    case unknown(String)

    public static var allCases: [ResearchChartBuilderPreset] { [.priceVolume, .sma, .bollinger, .rsi, .macd, .rebased] }

    private static let known: [String: Self] = ["priceVolume": .priceVolume, "sma": .sma, "bollinger": .bollinger, "rsi": .rsi, "macd": .macd, "rebased": .rebased]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .priceVolume: return "priceVolume"
        case .sma: return "sma"
        case .bollinger: return "bollinger"
        case .rsi: return "rsi"
        case .macd: return "macd"
        case .rebased: return "rebased"
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
