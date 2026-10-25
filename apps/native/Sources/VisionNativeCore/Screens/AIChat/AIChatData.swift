import Foundation

public enum AIChatMode: String, Sendable { case chat, investigation }
public enum AIChatStreamStatus: String, Sendable {
    case idle, streaming, stopped, interrupted
    case timedOut = "timed_out"
}

public struct AIChatMessage: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: AiMessageID
    public let role: OpenAPI.AiMessage.Role
    public let content: String?
    public let toolName: String?
    public let toolArgs: TaxValue?
    public let toolResult: TaxValue?
    public let toolPresentation: TaxValue?
    public let status: OpenAPI.AiMessage.Status?
    public let createdAt: String?
    public var isOptimistic: Bool { id.rawValue.hasPrefix("__optimistic_user__") }
    public init(raw: TaxValue, sparse: Bool = false) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        id = sparse ? AiMessageID(raw["id"]?.stringValue ?? "") : AiMessageID(try ResearchDecode.string(raw["id"]))
        role = OpenAPI.AiMessage.Role(rawValue: try ResearchDecode.string(raw["role"]))
        content = try ResearchDecode.optionalString(raw["content"])
        toolName = try ResearchDecode.optionalString(raw["toolName"])
        toolArgs = raw["toolArgs"]
        toolResult = raw["toolResult"]
        toolPresentation = raw["toolPresentation"]
        status = try ResearchDecode.optionalString(raw["status"]).map { OpenAPI.AiMessage.Status(rawValue: $0) }
        createdAt = try ResearchDecode.optionalString(raw["createdAt"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIChatConversation: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let id: AiConversationID
    public let title: String
    public let model: String
    public let createdAt: String?
    public let updatedAt: String?
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        id = AiConversationID(try ResearchDecode.string(raw["id"]))
        title = try ResearchDecode.string(raw["title"])
        model = try ResearchDecode.string(raw["model"])
        createdAt = try ResearchDecode.optionalString(raw["createdAt"])
        updatedAt = try ResearchDecode.optionalString(raw["updatedAt"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIChatConversationDetail: Codable, Equatable, Sendable {
    public let conversation: AIChatConversation
    public var messages: [AIChatMessage]
    public init(conversation: AIChatConversation, messages: [AIChatMessage]) {
        self.conversation = conversation
        self.messages = messages
    }
}
public struct AIChatConversationPage: Codable, Equatable, Sendable {
    public let items: [AIChatConversation]
    public let total: Int
    public let limit: Int
    public let offset: Int
    public init(items: [AIChatConversation], total: Int, limit: Int, offset: Int) {
        self.items = items
        self.total = total
        self.limit = limit
        self.offset = offset
    }
}
public struct AIChatOllamaStatus: Codable, Equatable, Sendable {
    public let raw: TaxValue
    public let ok: Bool
    public let enabled: Bool
    public let baseUrl: String
    public let displayUrl: String?
    public let defaultModel: String
    public let modelCount: Int?
    public let error: String?
    public let code: String?
    public let hint: String?
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        ok = try ResearchDecode.required(raw["ok"], Bool.self)
        enabled = try ResearchDecode.required(raw["enabled"], Bool.self)
        baseUrl = try ResearchDecode.string(raw["baseUrl"])
        defaultModel = try ResearchDecode.string(raw["defaultModel"])
        displayUrl = try ResearchDecode.optionalString(raw["displayUrl"])
        modelCount = try raw["modelCount"].flatMap { $0 == .null ? nil : try $0.decode(Int.self) }
        error = try ResearchDecode.optionalString(raw["error"])
        code = try ResearchDecode.optionalString(raw["code"])
        hint = try ResearchDecode.optionalString(raw["hint"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIChatOllamaModel: Codable, Equatable, Sendable, Identifiable {
    public let raw: TaxValue
    public let name: String
    public let size: Decimal?
    public let family: String?
    public let parameterSize: String?
    public let quantization: String?
    public let modifiedAt: String?
    public var id: String { name }
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        name = try ResearchDecode.string(raw["name"])
        size = try ResearchDecode.optionalDecimal(raw["size"])
        family = try ResearchDecode.optionalString(raw["family"])
        parameterSize = try ResearchDecode.optionalString(raw["parameterSize"])
        quantization = try ResearchDecode.optionalString(raw["quantization"])
        modifiedAt = try ResearchDecode.optionalString(raw["modifiedAt"])
    }
    public init(from decoder: any Decoder) throws { try self.init(raw: TaxValue(from: decoder)) }
    public func encode(to encoder: any Encoder) throws { try raw.encode(to: encoder) }
}
public struct AIChatSendRequest: Equatable, Sendable {
    public let conversationID: AiConversationID
    public let message: String
    public var model: String?
    public var useTools: Bool
    public var insightsPreCall: Bool
    public var retryLastTurn: Bool
    public init(
        conversationID: AiConversationID, message: String, model: String? = nil, useTools: Bool = true,
        insightsPreCall: Bool = false, retryLastTurn: Bool = false
    ) {
        self.conversationID = conversationID
        self.message = message
        self.model = model
        self.useTools = useTools
        self.insightsPreCall = insightsPreCall
        self.retryLastTurn = retryLastTurn
    }
    public var raw: TaxValue {
        var fields: [String: TaxValue] = [
            "conversationId": .string(conversationID.rawValue), "message": .string(message), "useTools": .bool(useTools),
        ]
        if let model { fields["model"] = .string(model) }
        if insightsPreCall { fields["insightsPreCall"] = .bool(true) }
        if retryLastTurn { fields["retryLastTurn"] = .bool(true) }
        return .object(fields)
    }
}
public struct AIChatComplete: Equatable, Sendable {
    public let raw: TaxValue
    public let conversation: AIChatConversation?
    public let assistantMessage: AIChatMessage?
    public init(raw: TaxValue) throws {
        try ResearchDecode.requireObject(raw)
        self.raw = raw
        conversation = try? raw["conversation"].map { try AIChatConversation(raw: $0) }
        assistantMessage = try? raw["assistantMessage"].map { try AIChatMessage(raw: $0, sparse: true) }
    }
}
public enum AIChatEvent: Equatable, Sendable {
    case userMessage(AIChatMessage)
    case token(String)
    case toolCall(name: String, args: TaxValue)
    case toolResult(AIChatMessage)
    case complete(AIChatComplete)
    case error(detail: String, code: String?)
    public static func decode(_ frame: ServerSentEvent) -> Self? {
        let raw = try? JSONDecoder().decode(TaxValue.self, from: Data(frame.data.utf8))
        if frame.event == "token" {
            return .token(raw?.stringValue ?? (raw.map { AIChatText.javascriptString($0) } ?? frame.data))
        }
        guard let raw else { return nil }
        switch frame.event {
        case "user_message", "tool_result":
            guard let message = raw["message"], let decoded = try? AIChatMessage(raw: message, sparse: true) else {
                return nil
            }
            return frame.event == "user_message" ? .userMessage(decoded) : .toolResult(decoded)
        case "tool_call":
            guard let name = raw["name"]?.stringValue else { return nil }
            if let args = raw["args"], args.objectValue == nil { return nil }
            return .toolCall(name: name, args: raw["args"] ?? .object([:]))
        case "complete": return (try? AIChatComplete(raw: raw)).map(Self.complete)
        case "error":
            return .error(detail: raw["detail"]?.stringValue ?? "AI chat error", code: raw["code"]?.stringValue)
        default: return nil
        }
    }
}
public enum AIChatText {
    public static func javascriptString(_ value: TaxValue) -> String {
        switch value {
        case .null: return "null"
        case .bool(let value): return value ? "true" : "false"
        case .string(let value): return value
        case .number(let value): return NSDecimalNumber(decimal: value).stringValue
        case .object: return "[object Object]"
        case .array(let values): return values.map { $0 == .null ? "" : javascriptString($0) }.joined(separator: ",")
        }
    }
}
public enum AIChatStreamError: Error, Equatable, Sendable, LocalizedError {
    case timedOut, missingTerminal
    case terminal(detail: String, code: String?)
    public var errorDescription: String? {
        switch self {
        case .timedOut: return "Chat stream timed out"
        case .missingTerminal: return "Stream ended without terminal event"
        case .terminal(let detail, _): return detail
        }
    }
}
public struct AIChatStreamSnapshot: Equatable, Sendable {
    public var isStreaming = false
    public var status: AIChatStreamStatus = .idle
    public var assistantDraft = ""
    public var toolMessages: [AIChatMessage] = []
    public var userMessage: AIChatMessage?
    public var error: String?
    public var lastRequest: AIChatSendRequest?
    public init() {}
}
