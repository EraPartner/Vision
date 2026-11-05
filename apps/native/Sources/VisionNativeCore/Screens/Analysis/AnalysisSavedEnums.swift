import Foundation

/// `SavedAnalysis.refreshMode`. The decoder of a saved analysis rejects `.unknown`, as it always rejected other values.
public enum AnalysisRefreshMode: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case live
    case frozen
    case unknown(String)

    public static var allCases: [AnalysisRefreshMode] { [.live, .frozen] }

    private static let known: [String: Self] = ["live": .live, "frozen": .frozen]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .live: return "live"
        case .frozen: return "frozen"
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

/// `SavedAnalysis.refreshStatus`. The decoder of a saved analysis rejects `.unknown`, as it always rejected other values.
public enum AnalysisRefreshStatus: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case neverRun
    case running
    case succeeded
    case failed
    case cancelled
    case unknown(String)

    public static var allCases: [AnalysisRefreshStatus] { [.neverRun, .running, .succeeded, .failed, .cancelled] }

    private static let known: [String: Self] = ["never-run": .neverRun, "running": .running, "succeeded": .succeeded, "failed": .failed, "cancelled": .cancelled]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .neverRun: return "never-run"
        case .running: return "running"
        case .succeeded: return "succeeded"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
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
