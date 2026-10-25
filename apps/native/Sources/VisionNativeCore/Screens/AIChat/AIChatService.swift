import Foundation

public protocol AIChatService: Sendable {
    func chatInvalidateSharedReads(_ keys: [String]) async
    func chatStatus() async throws -> AIChatOllamaStatus
    func chatModels() async throws -> [AIChatOllamaModel]
    /// `GET /api/ai/model/fit`: memory facts for one model (`apiClient.getModelFit`).
    func chatModelFit(model: String) async throws -> OpenAPI.AiModelFit
    /// `POST /api/ai/model/warm`: best-effort, always 204 (`apiClient.warmModel`).
    func chatWarm(model: String) async throws
    /// `POST /api/ai/model/release`: best-effort, always 204 (`apiClient.releaseModel`).
    func chatRelease(model: String) async throws
    func chatConversations(offset: Int) async throws -> AIChatConversationPage
    func chatConversation(id: AiConversationID) async throws -> AIChatConversationDetail
    func chatCreate(model: String?) async throws -> AIChatConversationDetail
    func chatRename(id: AiConversationID, title: String) async throws -> AIChatConversation
    func chatDelete(id: AiConversationID) async throws
    func chatStream(_ request: AIChatSendRequest, onEvent: @escaping @Sendable (AIChatEvent) async -> Void) async throws
        -> AIChatComplete
}
extension AIChatService {
    public func chatInvalidateSharedReads(_ keys: [String]) async {}
    public func chatModelFit(model: String) async throws -> OpenAPI.AiModelFit {
        throw APIError.backendUnavailable
    }
    public func chatWarm(model: String) async throws {}
    public func chatRelease(model: String) async throws {}
}
private struct AIChatModelsResponse: Codable, Sendable {
    let items: [AIChatOllamaModel]
    let total: Int
}
extension APIClient: AIChatService {
    public func chatInvalidateSharedReads(_ keys: [String]) async { await invalidateSharedAIReads(keys: keys) }
    public func chatStatus() async throws -> AIChatOllamaStatus {
        try await coalescedAIRead(key: "ollama-status") {
            try await send(
                ResearchRequest<OpenAPIOperations.GetAiStatus, AIChatOllamaStatus>(OpenAPIOperations.GetAiStatus.self))
        }
    }
    public func chatModels() async throws -> [AIChatOllamaModel] {
        let response: AIChatModelsResponse = try await coalescedAIRead(key: "ollama-models") {
            try await send(
                ResearchRequest<OpenAPIOperations.GetAiModels, AIChatModelsResponse>(OpenAPIOperations.GetAiModels.self)
            )
        }
        return response.items
    }
    public func chatModelFit(model: String) async throws -> OpenAPI.AiModelFit {
        try await send(OpenAPIOperations.GetAiModelFit(model: model))
    }
    public func chatWarm(model: String) async throws {
        let _: APIEmpty = try await send(OpenAPIOperations.WarmAiModel(body: .init(model: model)))
    }
    public func chatRelease(model: String) async throws {
        let _: APIEmpty = try await send(OpenAPIOperations.ReleaseAiModel(body: .init(model: model)))
    }
    public func chatConversations(offset: Int) async throws -> AIChatConversationPage {
        try await send(
            ResearchRequest<OpenAPIOperations.GetAiConversations, AIChatConversationPage>(
                OpenAPIOperations.GetAiConversations.self,
                query: [.init(name: "limit", value: "50"), .init(name: "offset", value: String(offset))]))
    }
    public func chatConversation(id: AiConversationID) async throws -> AIChatConversationDetail {
        try await send(
            ResearchRequest<OpenAPIOperations.GetAiConversation, AIChatConversationDetail>(
                OpenAPIOperations.GetAiConversation.self, parameters: ["id": id.rawValue]))
    }
    public func chatCreate(model: String?) async throws -> AIChatConversationDetail {
        try await send(
            ResearchRequest<OpenAPIOperations.CreateAiConversation, AIChatConversationDetail>(
                OpenAPIOperations.CreateAiConversation.self, body: .object(model.map { ["model": .string($0)] } ?? [:]))
        )
    }
    public func chatRename(id: AiConversationID, title: String) async throws -> AIChatConversation {
        try await send(
            ResearchRequest<OpenAPIOperations.UpdateAiConversation, AIChatConversation>(
                OpenAPIOperations.UpdateAiConversation.self, parameters: ["id": id.rawValue],
                body: .object(["title": .string(title)])))
    }
    public func chatDelete(id: AiConversationID) async throws {
        let _: APIEmpty = try await send(
            ResearchRequest<OpenAPIOperations.DeleteAiConversation, APIEmpty>(
                OpenAPIOperations.DeleteAiConversation.self, parameters: ["id": id.rawValue]))
    }
    public func chatStream(_ request: AIChatSendRequest, onEvent: @escaping @Sendable (AIChatEvent) async -> Void)
        async throws -> AIChatComplete
    {
        let body = try APIBody.encode(request.raw)
        return try await AIChatStreamReader().read(onEvent: onEvent) { receive in
            try await streamJSONEvents(
                path: "/api/ai/chat/stream", body: body, fallbackMessage: "Chat stream failed", onEvent: receive)
        }
    }
}

/// Chat-specific terminal and stall semantics over the common production SSE transport.
public actor AIChatStreamReader {
    private let stallNanoseconds: UInt64
    private let sleep: @Sendable (UInt64) async throws -> Void
    private var watchdog: Task<Void, Never>?
    private var requestTask: Task<Void, Error>?
    private var timedOut = false
    private var complete: AIChatComplete?
    private var terminalError: AIChatStreamError?
    public init(stallNanoseconds: UInt64 = 120_000_000_000) {
        self.stallNanoseconds = stallNanoseconds
        self.sleep = { try await Task.sleep(nanoseconds: $0) }
    }
    init(
        stallNanoseconds: UInt64,
        sleep: @escaping @Sendable (UInt64) async throws -> Void
    ) {
        self.stallNanoseconds = stallNanoseconds
        self.sleep = sleep
    }
    public func read(
        onEvent: @escaping @Sendable (AIChatEvent) async -> Void,
        frames: @escaping @Sendable (@escaping @Sendable (ServerSentEvent) async throws -> Void) async throws -> Void
    ) async throws -> AIChatComplete {
        let task = Task { try await frames { frame in await self.receive(frame, onEvent: onEvent) } }
        requestTask = task
        armWatchdog()
        defer {
            watchdog?.cancel()
            watchdog = nil
            requestTask = nil
        }
        do {
            try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
        } catch {
            if timedOut { throw AIChatStreamError.timedOut }
            throw error
        }
        if timedOut { throw AIChatStreamError.timedOut }
        if let terminalError { throw terminalError }
        guard let complete else { throw AIChatStreamError.missingTerminal }
        return complete
    }
    private func armWatchdog() {
        watchdog?.cancel()
        watchdog = Task {
            do { try await sleep(stallNanoseconds) } catch { return }
            timedOut = true
            requestTask?.cancel()
        }
    }
    private func receive(_ frame: ServerSentEvent, onEvent: @escaping @Sendable (AIChatEvent) async -> Void) async {
        armWatchdog()
        guard let event = AIChatEvent.decode(frame) else { return }
        switch event {
        case .complete(let payload):
            guard complete == nil else { return }
            complete = payload
        case .error(let detail, let code): terminalError = .terminal(detail: detail, code: code)
        default: break
        }
        await onEvent(event)
    }
}
