import Foundation
import Observation

/// App-lifetime streams and conversation cache; page navigation never cancels a turn.
@MainActor @Observable public final class AIChatStreamStore {
    public private(set) var snapshots: [AiConversationID: AIChatStreamSnapshot] = [:]
    public private(set) var details: [AiConversationID: AIChatConversationDetail] = [:]
    public private(set) var detailDates: [AiConversationID: Date] = [:]
    public private(set) var activeIDs: [AiConversationID] = []
    public var didInvalidate: (@MainActor (AiConversationID) async -> Void)?
    public var didError: (@MainActor (Error) -> Void)?
    @ObservationIgnored private let service: any AIChatService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var tasks: [AiConversationID: Task<AIChatComplete, Error>] = [:]
    @ObservationIgnored private var generations: [AiConversationID: UUID] = [:]
    @ObservationIgnored private var revisions: [AiConversationID: Int] = [:]
    public init(service: any AIChatService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }
    public func snapshot(id: AiConversationID?) -> AIChatStreamSnapshot { id.flatMap { snapshots[$0] } ?? .init() }
    public func revision(id: AiConversationID) -> Int { revisions[id] ?? 0 }
    public func cache(_ detail: AIChatConversationDetail, date: Date? = nil) {
        let id = detail.conversation.id
        details[id] = detail
        detailDates[id] = date ?? now()
    }
    public func invalidateDetail(id: AiConversationID) { detailDates[id] = nil }
    public func remove(id: AiConversationID) {
        details[id] = nil
        detailDates[id] = nil
        clear(id: id)
    }
    public func clear(id: AiConversationID) {
        generations[id] = UUID()
        tasks[id] = nil
        snapshots[id] = nil
        synchronizeActiveIDs()
    }
    public func stop(id: AiConversationID) {
        generations[id] = UUID()
        tasks[id]?.cancel()
        tasks[id] = nil
        if var current = snapshots[id], current.isStreaming {
            current.isStreaming = false
            current.status = .stopped
            current.error = nil
            snapshots[id] = current
        }
        synchronizeActiveIDs()
    }
    private func synchronizeActiveIDs() {
        let continuing = activeIDs.filter { snapshots[$0]?.isStreaming == true }
        activeIDs =
            continuing
            + snapshots.keys.filter { snapshots[$0]?.isStreaming == true && !continuing.contains($0) }.sorted()
    }
    private func touch(_ id: AiConversationID) { revisions[id, default: 0] += 1 }
    private func merge(_ message: AIChatMessage, id: AiConversationID) {
        guard var detail = details[id], !detail.messages.contains(where: { $0.id == message.id }) else { return }
        detail.messages.append(message)
        details[id] = detail
    }
    public func send(_ request: AIChatSendRequest) async {
        let id = request.conversationID
        let generation = UUID()
        generations[id] = generation
        tasks[id]?.cancel()
        var initial = AIChatStreamSnapshot()
        initial.isStreaming = true
        initial.status = .streaming
        initial.lastRequest = request
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        initial.userMessage = try? AIChatMessage(
            raw: .object([
                "id": .string("__optimistic_user__" + UUID().uuidString),
                "role": .string(OpenAPI.AiMessage.Role.user.rawValue),
                "content": .string(request.message), "createdAt": .string(formatter.string(from: now())),
            ]))
        snapshots[id] = initial
        touch(id)
        synchronizeActiveIDs()
        let service = service
        let task = Task {
            try await service.chatStream(request) { [weak self] event in
                await self?.receive(event, id: id, generation: generation)
            }
        }
        tasks[id] = task
        do {
            _ = try await task.value
            guard generations[id] == generation else { return }
            snapshots[id] = nil
            tasks[id] = nil
            synchronizeActiveIDs()
        } catch {
            guard generations[id] == generation else { return }
            tasks[id] = nil
            if Self.isAlreadyComplete(error) {
                snapshots[id] = nil
                synchronizeActiveIDs()
                do {
                    let detail = try await service.chatConversation(id: id)
                    guard generations[id] == generation else { return }
                    cache(detail)
                } catch { /* The normal invalidation read exposes any refresh failure. */  }
                await didInvalidate?(id)
                return
            }
            var current = snapshots[id] ?? initial
            current.isStreaming = false
            current.status = (error as? AIChatStreamError) == .timedOut ? .timedOut : .interrupted
            current.error = error.localizedDescription
            snapshots[id] = current
            synchronizeActiveIDs()
            didError?(error)
        }
    }
    private static func isAlreadyComplete(_ error: Error) -> Bool {
        if case .terminal(_, let code) = error as? AIChatStreamError { return code == "TURN_ALREADY_COMPLETE" }
        if case .client(let value) = error as? APIError { return value.code.rawValue == "TURN_ALREADY_COMPLETE" }
        return false
    }
    private func receive(_ event: AIChatEvent, id: AiConversationID, generation: UUID) async {
        guard generations[id] == generation else { return }
        var current = snapshots[id] ?? .init()
        switch event {
        case .userMessage(let message):
            current.userMessage = message
            merge(message, id: id)
            touch(id)
        case .token(let delta): current.assistantDraft += delta
        case .toolResult(let message):
            current.toolMessages.append(message)
            merge(message, id: id)
            touch(id)
        case .error(let detail, _):
            current.isStreaming = false
            current.status = .interrupted
            current.error = detail
        case .toolCall: return
        case .complete(let payload):
            if let existing = details[id] {
                var messages = existing.messages
                var seen = Set(messages.map(\.id))
                let additions =
                    (current.userMessage.map { $0.isOptimistic ? [] : [$0] } ?? []) + current.toolMessages
                    + (payload.assistantMessage.map { [$0] } ?? [])
                for message in additions where seen.insert(message.id).inserted { messages.append(message) }
                cache(.init(conversation: payload.conversation ?? existing.conversation, messages: messages))
            }
            touch(id)
            snapshots[id] = nil
            synchronizeActiveIDs()
            Task { await didInvalidate?(id) }
            return
        }
        snapshots[id] = current
        synchronizeActiveIDs()
    }
}
