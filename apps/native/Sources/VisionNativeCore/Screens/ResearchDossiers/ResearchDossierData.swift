import Foundation

public struct ResearchDossierSource: Codable, Equatable, Sendable {
    public var title: String
    public var reference: String
    public var sourceDate: String?
    public var accessedAt: String?
    public var documentId: String?
    public var documentVersion: Int?
    public var passageOrdinal: Int?
    public var contentSha256: String?
    private var extras: [String: TaxValue] = [:]
    public init(title: String = "", reference: String = "", sourceDate: String? = nil, accessedAt: String? = nil) {
        self.title = title
        self.reference = reference
        self.sourceDate = sourceDate
        self.accessedAt = accessedAt
    }
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        title = try ResearchDecode.string(raw["title"])
        reference = try ResearchDecode.string(raw["reference"])
        sourceDate = try ResearchDossierDecode.nullableString(raw["sourceDate"])
        accessedAt = try ResearchDossierDecode.nullableString(raw["accessedAt"])
        documentId = try raw["documentId"].map { try ResearchDecode.string($0) }
        documentVersion = try raw["documentVersion"].map { try ResearchDecode.count($0) }
        passageOrdinal = try raw["passageOrdinal"].map { try ResearchDecode.count($0) }
        contentSha256 = try raw["contentSha256"].map { try ResearchDecode.string($0) }
        if let documentVersion, documentVersion <= 0 {
            throw ResearchDecode.failure("Invalid dossier document version")
        }
        extras = (raw.objectValue ?? [:]).filter { !Self.keys.contains($0.key) }
    }
    private static let keys = [
        "title", "reference", "sourceDate", "accessedAt", "documentId", "documentVersion", "passageOrdinal",
        "contentSha256",
    ]
    public var payload: TaxValue {
        var fields = extras
        fields["title"] = .string(title)
        fields["reference"] = .string(reference)
        fields["sourceDate"] = sourceDate.map(TaxValue.string) ?? .null
        fields["accessedAt"] = accessedAt.map(TaxValue.string) ?? .null
        fields["documentId"] = documentId.map(TaxValue.string)
        fields["documentVersion"] = documentVersion.map { .number(Decimal($0)) }
        fields["passageOrdinal"] = passageOrdinal.map { .number(Decimal($0)) }
        fields["contentSha256"] = contentSha256.map(TaxValue.string)
        return .object(fields)
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try payload.encode(to: encoder) }
}
public struct ResearchDossierEvidence: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var stance: String
    public var origin: String
    public var claim: String
    public var source: ResearchDossierSource
    public var notes: String
    private var extras: [String: TaxValue] = [:]
    public init(id: String = UUID().uuidString) {
        self.id = id
        stance = "context"
        origin = "user"
        claim = ""
        source = .init()
        notes = ""
    }
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        id = try ResearchDecode.string(raw["id"])
        stance = try ResearchDecode.string(raw["stance"])
        origin = try ResearchDecode.string(raw["origin"])
        claim = try ResearchDecode.string(raw["claim"])
        source = try ResearchDecode.required(raw["source"], ResearchDossierSource.self)
        notes = try ResearchDecode.string(raw["notes"])
        guard ["support", "oppose", "context"].contains(stance), ["user", "ai-draft"].contains(origin) else {
            throw ResearchDecode.failure("Invalid dossier evidence classification")
        }
        extras = (raw.objectValue ?? [:]).filter {
            !["id", "stance", "origin", "claim", "source", "notes"].contains($0.key)
        }
    }
    public var payload: TaxValue {
        .object(
            extras.merging([
                "id": .string(id), "stance": .string(stance), "origin": .string(origin), "claim": .string(claim),
                "source": source.payload, "notes": .string(notes),
            ]) { _, current in current })
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try payload.encode(to: encoder) }
}
public enum ResearchDossierLinkField: String, Sendable { case categoryIds, investmentIds, savedAnalysisIds }
public struct ResearchDossierLinks: Codable, Equatable, Sendable {
    public var categoryIds: [Int]
    public var investmentIds: [Int]
    public var savedAnalysisIds: [String]
    private var extras: [String: TaxValue] = [:]
    public init(categoryIds: [Int] = [], investmentIds: [Int] = [], savedAnalysisIds: [String] = []) {
        self.categoryIds = categoryIds
        self.investmentIds = investmentIds
        self.savedAnalysisIds = savedAnalysisIds
    }
    public init(raw: TaxValue) throws {
        categoryIds = try ResearchDecode.required(raw["categoryIds"], [Int].self)
        investmentIds = try ResearchDecode.required(raw["investmentIds"], [Int].self)
        savedAnalysisIds = try ResearchDecode.required(raw["savedAnalysisIds"], [String].self)
        guard (categoryIds + investmentIds).allSatisfy({ $0 > 0 }) else {
            throw ResearchDecode.failure("Invalid dossier link ID")
        }
        extras = (raw.objectValue ?? [:]).filter {
            !["categoryIds", "investmentIds", "savedAnalysisIds"].contains($0.key)
        }
    }
    public var payload: TaxValue {
        .object(
            extras.merging([
                "categoryIds": .array(categoryIds.map { .number(Decimal($0)) }),
                "investmentIds": .array(investmentIds.map { .number(Decimal($0)) }),
                "savedAnalysisIds": .array(savedAnalysisIds.map(TaxValue.string)),
            ]) { _, current in current })
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try payload.encode(to: encoder) }
}
public struct ResearchDossierContent: Codable, Equatable, Sendable {
    public static let workspaces = ["budgeting", "portfolio", "research", "cross-workspace"]
    public var title = ""
    public var workspace = "research"
    public var question = ""
    public var userThesis = ""
    public var assumptions: [String] = []
    public var openQuestions: [String] = []
    public var conclusion = ""
    public var reviewDate: String?
    public var evidence: [ResearchDossierEvidence] = []
    public var links = ResearchDossierLinks()
    public init() {}
    public init(raw: TaxValue) throws {
        title = try ResearchDecode.string(raw["title"])
        workspace = try ResearchDecode.string(raw["workspace"])
        question = try ResearchDecode.string(raw["question"])
        userThesis = try ResearchDecode.string(raw["userThesis"])
        assumptions = try ResearchDecode.required(raw["assumptions"], [String].self)
        openQuestions = try ResearchDecode.required(raw["openQuestions"], [String].self)
        conclusion = try ResearchDecode.string(raw["conclusion"])
        reviewDate = try ResearchDossierDecode.nullableString(raw["reviewDate"])
        evidence = try ResearchDecode.required(raw["evidence"], [ResearchDossierEvidence].self)
        links = try ResearchDecode.required(raw["links"], ResearchDossierLinks.self)
        guard Self.workspaces.contains(workspace) else { throw ResearchDecode.failure("Invalid dossier workspace") }
    }
    /// The page destructures only content fields from a hydrated record before writing.
    public var payload: TaxValue {
        .object([
            "title": .string(title), "workspace": .string(workspace), "question": .string(question),
            "userThesis": .string(userThesis),
            "assumptions": .array(assumptions.map(TaxValue.string)),
            "openQuestions": .array(openQuestions.map(TaxValue.string)), "conclusion": .string(conclusion),
            "reviewDate": reviewDate.map(TaxValue.string) ?? .null, "evidence": .array(evidence.map(\.payload)),
            "links": links.payload,
        ])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try payload.encode(to: encoder) }
}
public struct ResearchDossierLinkDetail: Decodable, Equatable, Sendable, Identifiable {
    public let kind: String
    public let historicalId: String
    public let labelSnapshot: String
    public let liveId: TaxValue
    public let status: String
    public var id: String { kind + ":" + historicalId }
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        kind = try ResearchDecode.string(raw["kind"])
        historicalId = try ResearchDecode.string(raw["historicalId"])
        labelSnapshot = try ResearchDecode.string(raw["labelSnapshot"])
        status = try ResearchDecode.string(raw["status"])
        guard ["category", "investment", "saved-analysis"].contains(kind), ["live", "deleted"].contains(status),
            let liveId = raw["liveId"], liveId == .null || liveId.stringValue != nil || liveId.decimalValue != nil
        else { throw ResearchDecode.failure("Invalid dossier historical link") }
        self.liveId = liveId
    }
}
public struct ResearchDossier: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: String
    public let version: Int
    public let content: ResearchDossierContent
    public let createdAt: String
    public let updatedAt: String
    public let linkDetails: [ResearchDossierLinkDetail]
    public var title: String { content.title }
    public var workspace: String { content.workspace }
    public init(raw: TaxValue) throws {
        self.raw = raw
        id = try ResearchDecode.string(raw["id"])
        version = try ResearchDecode.count(raw["version"])
        content = try .init(raw: raw)
        createdAt = try ResearchDecode.string(raw["createdAt"])
        updatedAt = try ResearchDecode.string(raw["updatedAt"])
        linkDetails = try ResearchDecode.required(raw["linkDetails"], [ResearchDossierLinkDetail].self)
        guard version > 0 else { throw ResearchDecode.failure("Invalid dossier version") }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct ResearchDossierListItem: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let workspace: String
    public let version: Int
    public let createdAt: String
    public let updatedAt: String
    public let question: String?
    public let reviewDate: String?
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        id = try ResearchDecode.string(raw["id"])
        title = try ResearchDecode.string(raw["title"])
        workspace = try ResearchDecode.string(raw["workspace"])
        version = try ResearchDecode.count(raw["version"])
        createdAt = try ResearchDecode.string(raw["createdAt"])
        updatedAt = try ResearchDecode.string(raw["updatedAt"])
        question = try ResearchDossierDecode.nullableString(raw["question"])
        reviewDate = try ResearchDossierDecode.nullableString(raw["reviewDate"])
        guard version > 0, ResearchDossierContent.workspaces.contains(workspace) else {
            throw ResearchDecode.failure("Invalid dossier list summary")
        }
    }
}
public struct ResearchDossierListPage: Decodable, Equatable, Sendable {
    public let items: [ResearchDossierListItem]
    public let total: Int
    public let limit: Int
    public let offset: Int
}
public struct ResearchDossierVersion: Decodable, Equatable, Sendable, Identifiable {
    public let version: Int
    public let snapshot: ResearchDossierContent
    public let createdAt: String
    public var id: Int { version }
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        version = try ResearchDecode.count(raw["version"])
        snapshot = try ResearchDecode.required(raw["snapshot"], ResearchDossierContent.self)
        createdAt = try ResearchDecode.string(raw["createdAt"])
        guard version > 0 else { throw ResearchDecode.failure("Invalid dossier history version") }
    }
}
public struct ResearchDossierExport: Decodable, Equatable, Sendable {
    public let raw: TaxValue
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        guard raw["schemaVersion"] == .number(1), raw["exportedAt"]?.stringValue != nil,
            let dossiers = raw["dossiers"]?.arrayValue
        else { throw ResearchDecode.failure("Invalid dossier export") }
        for dossier in dossiers {
            _ = try ResearchDossier(raw: dossier)
            _ = try ResearchDecode.required(dossier["versions"], [ResearchDossierVersion].self)
        }
        self.raw = raw
    }
    public func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(raw)
    }
}
public struct ResearchDossierPickerItem: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public var numericId: Int? { Int(id) }
}
public struct ResearchDossierDocument: Decodable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: String
    public let title: String
    public let version: Int
    public let extractionStatus: String
    public init(from decoder: any Decoder) throws {
        let raw = try TaxValue(from: decoder)
        self.raw = raw
        id = try ResearchDecode.string(raw["id"])
        title = try ResearchDecode.string(raw["title"])
        version = try ResearchDecode.count(raw["version"])
        extractionStatus = try ResearchDecode.string(raw["extractionStatus"])
        for key in ["sourceName", "mediaType", "contentSha256", "createdAt", "updatedAt"] {
            _ = try ResearchDecode.string(raw[key])
        }
        _ = try ResearchDossierDecode.nullableString(raw["extractionError"])
        guard version > 0, ["ready", "failed", "unsupported"].contains(extractionStatus) else {
            throw ResearchDecode.failure("Invalid dossier research document")
        }
    }
}
private enum ResearchDossierDecode {
    static func nullableString(_ value: TaxValue?) throws -> String? {
        guard let value else { throw ResearchDecode.failure("Missing nullable dossier string") }
        return try ResearchDecode.optionalString(value)
    }
}
