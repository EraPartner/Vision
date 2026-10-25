import Foundation

/// The `kind` of a research presentation request. A kind this client does not know is rejected.
public enum ResearchPresentationKind: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case compare
    case chart
    case watchlist
    case watchlistBatch
    case providerQuote
    case analyst
    case marketAdd
    case unknown(String)

    public static var allCases: [ResearchPresentationKind] { [.compare, .chart, .watchlist, .watchlistBatch, .providerQuote, .analyst, .marketAdd] }

    private static let known: [String: Self] = ["compare": .compare, "chart": .chart, "watchlist": .watchlist, "watchlistBatch": .watchlistBatch, "providerQuote": .providerQuote, "analyst": .analyst, "marketAdd": .marketAdd]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .compare: return "compare"
        case .chart: return "chart"
        case .watchlist: return "watchlist"
        case .watchlistBatch: return "watchlistBatch"
        case .providerQuote: return "providerQuote"
        case .analyst: return "analyst"
        case .marketAdd: return "marketAdd"
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
