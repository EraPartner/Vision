import Foundation

/// How a piece of evidence relates to the thesis. The dossier decoder rejects `.unknown`, as it always rejected other values.
public enum ResearchDossierStance: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case support
    case oppose
    case context
    case unknown(String)

    public static var allCases: [ResearchDossierStance] { [.support, .oppose, .context] }

    private static let known: [String: Self] = ["support": .support, "oppose": .oppose, "context": .context]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .support: return "support"
        case .oppose: return "oppose"
        case .context: return "context"
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

/// Who wrote a piece of evidence. The dossier decoder rejects `.unknown`, as it always rejected other values.
public enum ResearchDossierOrigin: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case user
    case aiDraft
    case unknown(String)

    public static var allCases: [ResearchDossierOrigin] { [.user, .aiDraft] }

    private static let known: [String: Self] = ["user": .user, "ai-draft": .aiDraft]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .user: return "user"
        case .aiDraft: return "ai-draft"
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

/// What a dossier link points at. The dossier decoder rejects `.unknown`, as it always rejected other values.
public enum ResearchDossierLinkKind: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case category
    case investment
    case savedAnalysis
    case unknown(String)

    public static var allCases: [ResearchDossierLinkKind] { [.category, .investment, .savedAnalysis] }

    private static let known: [String: Self] = ["category": .category, "investment": .investment, "saved-analysis": .savedAnalysis]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .category: return "category"
        case .investment: return "investment"
        case .savedAnalysis: return "saved-analysis"
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

/// Whether a dossier link still resolves. The dossier decoder rejects `.unknown`, as it always rejected other values.
public enum ResearchDossierLinkStatus: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case live
    case deleted
    case unknown(String)

    public static var allCases: [ResearchDossierLinkStatus] { [.live, .deleted] }

    private static let known: [String: Self] = ["live": .live, "deleted": .deleted]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .live: return "live"
        case .deleted: return "deleted"
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
