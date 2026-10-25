import Foundation

public struct OpenAIResearchModel: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: String
    public let label: String
    public let inputMicrosPerMillion: Decimal
    public let outputMicrosPerMillion: Decimal
    public let isDefault: Bool
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        id = try ResearchDecode.string(raw["id"])
        label = try ResearchDecode.string(raw["label"])
        inputMicrosPerMillion = try ResearchDecode.decimal(raw["inputMicrosPerMillion"])
        outputMicrosPerMillion = try ResearchDecode.decimal(raw["outputMicrosPerMillion"])
        isDefault = try ResearchDecode.bool(raw["isDefault"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIResearchStatus: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let openAiEnabled: Bool
    public let openAiModel: String?
    public let openAiModels: [OpenAIResearchModel]
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        guard let openai = raw["openai"] else { throw ResearchDecode.failure("Missing AI status") }
        openAiEnabled = try ResearchDecode.bool(openai["enabled"])
        openAiModel = try ResearchDecode.optionalString(openai["model"])
        openAiModels = try AIInvestigationDecode.array(openai["models"]).map { try .init(raw: $0) }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIResearchDocument: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: String
    public let title: String
    public let sourceName: String
    public let mediaType: String
    public let version: Int
    public let extractionStatus: String
    public let extractionError: String?
    public let createdAt: String
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        id = try ResearchDecode.string(raw["id"])
        title = try ResearchDecode.string(raw["title"])
        sourceName = try ResearchDecode.string(raw["sourceName"])
        mediaType = try ResearchDecode.string(raw["mediaType"])
        version = try ResearchDecode.count(raw["version"])
        extractionStatus = try ResearchDecode.string(raw["extractionStatus"])
        guard version > 0, ["ready", "failed", "unsupported"].contains(extractionStatus) else {
            throw ResearchDecode.failure("Invalid research document")
        }
        extractionError = try ResearchDecode.optionalString(raw["extractionError"])
        createdAt = try ResearchDecode.string(raw["createdAt"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIResearchDocumentFile: Equatable, Sendable {
    public let name: String
    public let contentType: String
    public let data: Data
    public init(name: String, contentType: String, data: Data) {
        self.name = name
        self.contentType = contentType
        self.data = data
    }
}
public struct AIEvidence: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: String
    public let kind: String
    public let label: String
    public let sourceDate: String?
    public let locator: String
    public let excerpt: String?
    public let available: Bool
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        id = try ResearchDecode.string(raw["id"])
        kind = try ResearchDecode.string(raw["kind"])
        label = try ResearchDecode.string(raw["label"])
        sourceDate = try ResearchDecode.optionalString(raw["sourceDate"])
        locator = try ResearchDecode.string(raw["locator"])
        excerpt = try ResearchDecode.optionalString(raw["excerpt"])
        available = try ResearchDecode.bool(raw["available"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIAnswerStatement: Equatable, Sendable {
    public let text: String
    public let evidenceIds: [String]
    public init(raw: TaxValue) throws {
        text = try ResearchDecode.string(raw["text"])
        evidenceIds = try AIInvestigationDecode.strings(raw["evidenceIds"])
    }
}
public struct AIAnswer: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let status: String
    public let depth: String
    public let language: String
    public let summary: String
    public let facts: [AIAnswerStatement]
    public let calculations: [AIAnswerStatement]
    public let interpretations: [AIAnswerStatement]
    public let assumptions: [String]
    public let missingInformation: [String]
    public let evidence: [AIEvidence]
    public let analysisReference: TaxValue?
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        status = try ResearchDecode.string(raw["status"])
        depth = try ResearchDecode.string(raw["depth"])
        language = try ResearchDecode.string(raw["language"])
        summary = try ResearchDecode.string(raw["summary"])
        facts = try AIInvestigationDecode.array(raw["facts"]).map { try .init(raw: $0) }
        calculations = try AIInvestigationDecode.array(raw["calculations"]).map { try .init(raw: $0) }
        interpretations = try AIInvestigationDecode.array(raw["interpretations"]).map {
            try .init(raw: $0)
        }
        assumptions = try AIInvestigationDecode.strings(raw["assumptions"])
        missingInformation = try AIInvestigationDecode.strings(raw["missingInformation"])
        evidence = try AIInvestigationDecode.array(raw["evidence"]).map { try .init(raw: $0) }
        analysisReference = raw["analysisReference"] == .null ? nil : raw["analysisReference"]
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIInvestigation: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: String
    public let question: String
    public let route: String
    public let depth: String
    public let language: String
    public let state: String
    public let plan: TaxValue?
    public let result: AIAnswer?
    public let error: TaxValue?
    public var steps: [TaxValue] { raw["steps"]?.arrayValue ?? [] }
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        id = try ResearchDecode.string(raw["id"])
        question = try ResearchDecode.string(raw["question"])
        route = try ResearchDecode.string(raw["route"])
        depth = try ResearchDecode.string(raw["depth"])
        language = try ResearchDecode.string(raw["language"])
        state = try ResearchDecode.string(raw["state"])
        plan = raw["plan"] == .null ? nil : raw["plan"]
        error = raw["error"] == .null ? nil : raw["error"]
        result = try raw["result"].flatMap { $0 == .null ? nil : try .init(raw: $0) }
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIDisclosurePreview: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let payload: TaxValue
    public let payloadSha256: String
    public let payloadBytes: Int
    public let fieldManifest: [String]
    public let disclosureUnits: [String]
    public let referenceScope: TaxValue?
    public let outboundRequest: TaxValue
    public let agentCloakPreflight: TaxValue
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        guard let payload = raw["payload"], let outbound = raw["outboundRequest"],
            let preflight = raw["agentCloakPreflight"]
        else {
            throw ResearchDecode.failure("Incomplete AI disclosure preview")
        }
        try ResearchDecode.requireObject(payload)
        try ResearchDecode.requireObject(outbound)
        try ResearchDecode.requireObject(preflight)
        self.payload = payload
        outboundRequest = outbound
        agentCloakPreflight = preflight
        payloadSha256 = try ResearchDecode.string(raw["payloadSha256"])
        payloadBytes = try ResearchDecode.count(raw["payloadBytes"])
        fieldManifest = try AIInvestigationDecode.strings(raw["fieldManifest"])
        disclosureUnits = try AIInvestigationDecode.strings(raw["disclosureUnits"])
        referenceScope = raw["referenceScope"] == .null ? nil : raw["referenceScope"]
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public enum AIInvestigationDecode {
    static func array(_ raw: TaxValue?) throws -> [TaxValue] {
        guard let rows = raw?.arrayValue else {
            throw ResearchDecode.failure("Expected AI research array")
        }
        return rows
    }
    static func strings(_ raw: TaxValue?) throws -> [String] {
        try AIInvestigationDecode.array(raw).map { try ResearchDecode.string($0) }
    }
}
