import Foundation

/// The investigation request enums are the generated ones; the response-only vocabularies below
/// (packages/types/src/aiResearch.ts, contracts/researchAi.ts) have no generated model.
public typealias AIInvestigationDepth = OpenAPI.AiInvestigationRequest.Depth
public typealias AIInvestigationLanguage = OpenAPI.AiInvestigationRequest.Language
public typealias AIInvestigationRoute = OpenAPI.AiInvestigationRequest.Route
public typealias AIResearchMode = OpenAPI.AiInvestigationRequest.ResearchMode

/// `AI_INVESTIGATION_STATUSES`; a value this client does not know decodes to `.unknown`.
public enum AIInvestigationState: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case queued
    case running
    case waiting
    case partial
    case completed
    case failed
    case cancelled
    case unknown(String)

    public static var allCases: [AIInvestigationState] { [.queued, .running, .waiting, .partial, .completed, .failed, .cancelled] }

    private static let known: [String: Self] = ["queued": .queued, "running": .running, "waiting": .waiting, "partial": .partial, "completed": .completed, "failed": .failed, "cancelled": .cancelled]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .queued: return "queued"
        case .running: return "running"
        case .waiting: return "waiting"
        case .partial: return "partial"
        case .completed: return "completed"
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

/// `aiAnswerSchema.status`; a value this client does not know decodes to `.unknown`.
public enum AIAnswerStatus: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case complete
    case qualified
    case abstained
    case partial
    case unknown(String)

    public static var allCases: [AIAnswerStatus] { [.complete, .qualified, .abstained, .partial] }

    private static let known: [String: Self] = ["complete": .complete, "qualified": .qualified, "abstained": .abstained, "partial": .partial]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .complete: return "complete"
        case .qualified: return "qualified"
        case .abstained: return "abstained"
        case .partial: return "partial"
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

/// `aiEvidenceReferenceSchema.kind`; a value this client does not know decodes to `.unknown`.
public enum AIEvidenceKind: Codable, Hashable, Sendable, CaseIterable, RawRepresentable {
    case calculation
    case analysis
    case document
    case web
    case researchService
    case unknown(String)

    public static var allCases: [AIEvidenceKind] { [.calculation, .analysis, .document, .web, .researchService] }

    private static let known: [String: Self] = ["calculation": .calculation, "analysis": .analysis, "document": .document, "web": .web, "research-service": .researchService]
    public init(rawValue: String) { self = Self.known[rawValue] ?? .unknown(rawValue) }

    public var rawValue: String {
        switch self {
        case .calculation: return "calculation"
        case .analysis: return "analysis"
        case .document: return "document"
        case .web: return "web"
        case .researchService: return "research-service"
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

/// `extractionStatus` of a research document; any other value is a contract failure.
public enum AIDocumentExtractionStatus: String, Codable, CaseIterable, Sendable {
    case ready, failed, unsupported
}
