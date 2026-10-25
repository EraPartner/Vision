import Foundation

public struct NativeSettingsAIProviderStatus: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let provider: String
    public let label: String
    public let envVar: String
    public let configured: Bool
    public let source: String
    public let masked: String?
    public var id: String { provider }
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        provider = try ResearchDecode.string(raw["provider"])
        label = try ResearchDecode.string(raw["label"])
        envVar = try ResearchDecode.string(raw["envVar"])
        configured = try ResearchDecode.bool(raw["configured"])
        source = try ResearchDecode.string(raw["source"])
        guard ["settings", "env", "none"].contains(source) else {
            throw ResearchDecode.failure("Invalid provider key source")
        }
        masked = try ResearchDecode.optionalString(raw["masked"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct NativeSettingsAIProviderStatuses: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let items: [NativeSettingsAIProviderStatus]
    public let total: Int
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        items = try AIInvestigationDecode.array(raw["items"]).map { try .init(raw: $0) }
        total = try ResearchDecode.count(raw["total"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct NativeSettingsAIAgentCloakStatus: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let enabled: Bool
    public let available: Bool
    public let mappingKeyConfigured: Bool
    public let openAiEnabled: Bool
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        enabled = try ResearchDecode.bool(raw["enabled"])
        available = try ResearchDecode.bool(raw["available"])
        mappingKeyConfigured = try ResearchDecode.bool(raw["mappingKeyConfigured"])
        openAiEnabled = try ResearchDecode.bool(raw["openAiEnabled"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public enum NativeSettingsAIText {
    /// ECMAScript trim, including BOM but excluding NEL.
    public static func trim(_ value: String) -> String {
        value.trimmingCharacters(
            in: CharacterSet(
                charactersIn:
                    "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D} \u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
            ))
    }
    public static func benchmark(_ value: String) -> String? {
        let value = trim(value).uppercased()
        return value.isEmpty || value.range(of: #"^[A-Z0-9][A-Z0-9._:-]{0,31}$"#, options: .regularExpression) != nil
            ? value : nil
    }
    public static func limitBenchmark(_ value: String) -> String {
        guard value.utf16.count > 32 else { return value }
        var result = ""
        for character in value {
            let next = result + String(character)
            guard next.utf16.count <= 32 else { break }
            result = next
        }
        return result
    }
}

public struct NativeSettingsAIReceipt<Value: Sendable>: Sendable {
    public let value: Value
    public let fetchedAt: Date
    public init(value: Value, fetchedAt: Date) {
        self.value = value
        self.fetchedAt = fetchedAt
    }
}
