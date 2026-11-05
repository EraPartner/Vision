import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Native chat frames, app-lifetime turns and scoped reads") @MainActor
struct AIChatTests {
    @Test func messagesKeepUnknownToolMetadataDecimalsNullsAndLiteralWhitespace() throws {
        let raw: TaxValue = .object([
            "id": .string("tool"), "role": .string("tool"), "content": .string("  literal\n**text**  "),
            "toolResult": .object([
                "ok": .bool(true),
                "data": .array([.object(["amount": .string("123456789012345678901234567890.123456")])]),
            ]),
            "toolPresentation": .object([
                "columns": .array([.string("z"), .string("a")]),
                "pieRows": .array([.object(["percent": .number(Decimal(string: "0.1234567890123456789")!)])]),
            ]), "future": .null,
        ])
        let message = try AIChatMessage(raw: raw)
        #expect(message.content == "  literal\n**text**  ")
        #expect(message.toolPresentation?["columns"]?.arrayValue == [.string("z"), .string("a")])
        #expect(try JSONDecoder().decode(TaxValue.self, from: APIBody.encode(message)) == raw)
    }
    @Test func actualTypedAdaptersSendExactPageCreatePatchDeleteAndStreamBodies() async throws {
        let transport = ChatWireTransport()
        let client = APIClient(
            baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0)
        _ = try await client.chatStatus()
        _ = try await client.chatModels()
        _ = try await client.chatConversations(offset: 50)
        _ = try await client.chatConversation(id: "a/b")
        _ = try await client.chatCreate(model: "selected-model")
        _ = try await client.chatRename(id: "a", title: "new title")
        try await client.chatDelete(id: "a")
        let requests = await transport.recorded
        let query = URLComponents(url: requests[2].url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query.contains(.init(name: "limit", value: "50")))
        #expect(query.contains(.init(name: "offset", value: "50")))
        #expect(requests[3].url.absoluteString.contains("a%2Fb"))
        #expect(
            try JSONDecoder().decode(TaxValue.self, from: #require(requests[4].body))
                == .object(["model": .string("selected-model")]))
        #expect(
            try JSONDecoder().decode(TaxValue.self, from: #require(requests[5].body))
                == .object(["title": .string("new title")]))
        #expect(requests[6].method == .delete)
        let stream = AIChatSendRequest(
            conversationID: "a", message: "literal message", model: "selected-model", useTools: false,
            insightsPreCall: true, retryLastTurn: true)
        #expect(
            stream.raw
                == .object([
                    "conversationId": .string("a"), "message": .string("literal message"),
                    "model": .string("selected-model"), "useTools": .bool(false), "insightsPreCall": .bool(true),
                    "retryLastTurn": .bool(true),
                ]))
    }
    @Test func tolerantFramesKeepTokenFallbackAndMalformedTerminalErrorWithoutInventingMessages() throws {
        #expect(AIChatEvent.decode(.init(event: "token", data: "raw text")) == .token("raw text"))
        #expect(AIChatEvent.decode(.init(event: "token", data: "[1,null,\"x\"]")) == .token("1,,x"))
        #expect(AIChatEvent.decode(.init(event: "tool_result", data: "{\"message\":42}")) == nil)
        #expect(AIChatEvent.decode(.init(event: "error", data: "{}")) == .error(detail: "AI chat error", code: nil))
        #expect(AIChatEvent.decode(.init(event: "error", data: "not json")) == nil)
        #expect(AIChatEvent.decode(.init(event: "unknown", data: "{}")) == nil)
        #expect(AIChatEvent.decode(.init(event: "complete", data: "{}")) != nil)
    }
    @Test func firstCompletePublishesImmediatelyButErrorWinsOnlyAtEof() async throws {
        let service = ChatFixtureService()
        let store = AIChatStreamStore(service: service)
        store.cache(try chatDetail("a"))
        let sending = Task { await store.send(.init(conversationID: "a", message: "question")) }
        await service.waitForStream("a")
        try await service.push(
            "a", event: "user_message", raw: .object(["message": chatMessage("u", role: "user", content: "question")]))
        try await service.push("a", event: "token", raw: .string("partial"))
        try await service.push("a", event: "complete", raw: chatComplete("a", assistant: "first"))
        await waitUntil { !store.snapshot(id: "a").isStreaming }
        #expect(store.details["a"]?.messages.map(\.id) == ["u", "first"])
        try await service.push("a", event: "complete", raw: chatComplete("a", assistant: "duplicate"))
        try await service.push("a", event: "error", raw: .object(["detail": .string("Late terminal error")]))
        await service.finish("a")
        await sending.value
        #expect(store.snapshot(id: "a").status == .interrupted)
        #expect(store.snapshot(id: "a").error == "Late terminal error")
        #expect(store.details["a"]?.messages.last?.id == "first")
    }
    @Test func newerTurnSurvivesPreviousCompleteThenLateEofAndStopRetainsPartial() async throws {
        let service = ChatFixtureService()
        let store = AIChatStreamStore(service: service)
        store.cache(try chatDetail("a"))
        let first = Task { await store.send(.init(conversationID: "a", message: "first")) }
        await service.waitForStream("a")
        try await service.push("a", event: "complete", raw: chatComplete("a", assistant: "first-answer"))
        await waitUntil { !store.snapshot(id: "a").isStreaming }
        let second = Task { await store.send(.init(conversationID: "a", message: "second")) }
        await service.waitForStream("a", count: 2)
        await first.value
        #expect(store.snapshot(id: "a").lastRequest?.message == "second")
        #expect(store.snapshot(id: "a").isStreaming)
        try await service.push("a", event: "token", raw: .string("retained partial"))
        await waitUntil { store.snapshot(id: "a").assistantDraft == "retained partial" }
        store.stop(id: "a")
        await second.value
        #expect(store.snapshot(id: "a").status == .stopped)
        #expect(store.snapshot(id: "a").assistantDraft == "retained partial")
        #expect(store.snapshot(id: "a").lastRequest?.message == "second")
    }
    @Test func terminalLessEofIsInterruptedAndAlreadyCompleteReadsAuthoritativeConversation() async throws {
        let service = ChatFixtureService()
        let store = AIChatStreamStore(service: service)
        let interrupted = Task { await store.send(.init(conversationID: "a", message: "first")) }
        await service.waitForStream("a")
        await service.finish("a")
        await interrupted.value
        #expect(store.snapshot(id: "a").error == "Stream ended without terminal event")
        #expect(store.snapshot(id: "a").lastRequest != nil)
        await service.setDetail(
            try chatDetail("a", messages: [chatMessage("done", role: "assistant", content: "already done")]))
        let retry = Task { await store.send(.init(conversationID: "a", message: "first", retryLastTurn: true)) }
        await service.waitForStream("a", count: 2)
        try await service.push(
            "a", event: "error",
            raw: .object(["detail": .string("already complete"), "code": .string("TURN_ALREADY_COMPLETE")]))
        await service.finish("a")
        await retry.value
        #expect(store.snapshot(id: "a").status == .idle)
        #expect(store.details["a"]?.messages.last?.id == "done")
        #expect(await service.requests.count == 2)
    }
    @Test(.timeLimit(.minutes(1)))
    nonisolated func rawUnknownFramesResetStallWatchdogAndSilentStreamTimesOut() async throws {
        let clock = ChatWatchdogClock()
        let frames = AsyncStream<ServerSentEvent>.makeStream()
        let reader = AIChatStreamReader(stallNanoseconds: 200_000_000, sleep: { try await clock.sleep($0) })
        let reading = Task {
            try await reader.read(onEvent: { _ in }) { receive in
                for await frame in frames.stream { try await receive(frame) }
            }
        }
        defer {
            reading.cancel()
            frames.continuation.finish()
        }
        try await clock.waitForSleeps(1)
        // Every raw frame must retire the previous deadline, including undecodable frames.
        for count in 2...4 {
            frames.continuation.yield(.init(event: "unknown", data: "malformed"))
            try await clock.waitForSleeps(count)
            try await clock.waitForCancellations(count - 1)
            #expect(await clock.pendingCount == 1)
        }
        #expect(await clock.intervals == Array(repeating: 200_000_000, count: 4))
        frames.continuation.yield(.init(event: "complete", data: "{}"))
        frames.continuation.finish()
        let value = try await reading.value
        #expect(value.raw == .object([:]))
        let silentClock = ChatWatchdogClock()
        let silentFrames = AsyncStream<ServerSentEvent>.makeStream()
        let silentReading = Task {
            try await AIChatStreamReader(stallNanoseconds: 10_000_000, sleep: { try await silentClock.sleep($0) })
                .read(onEvent: { _ in }) { receive in
                    for await frame in silentFrames.stream { try await receive(frame) }
                }
        }
        defer {
            silentReading.cancel()
            silentFrames.continuation.finish()
        }
        try await silentClock.waitForSleeps(1)
        #expect(await silentClock.intervals == [10_000_000])
        await silentClock.expireCurrentSleep()
        do {
            _ = try await silentReading.value
            Issue.record("silent stream should time out")
        } catch { #expect(error as? AIChatStreamError == .timedOut) }
    }
    @Test func streamContinuesAcrossPageLeaveAndNoSelectionReattachesOnReturn() async throws {
        let service = ChatFixtureService()
        let model = AIChatModel(service: service)
        await model.load(route: NativeRoute(path: "/ai-chat", query: [.init(name: "c", value: "a")]))
        model.draft = "hello"
        let sending = Task { await model.send() }
        await service.waitForStream("a")
        model.didDisappear()
        #expect(model.streams.snapshot(id: "a").isStreaming)
        try await service.push("a", event: "token", raw: .string("while away"))
        await waitUntil { model.streams.snapshot(id: "a").assistantDraft == "while away" }
        await model.load(route: NativeRoute(path: "/ai-chat"))
        #expect(model.selectedID == "a")
        #expect(model.streamSnapshot.assistantDraft == "while away")
        model.stop()
        await sending.value
        #expect(model.streamSnapshot.status == .stopped)
    }
    @Test func toolsRetryAndDigestUseCapturedRequestAndModeChangesKeepComposerDraft() async throws {
        let service = ChatFixtureService()
        let model = AIChatModel(service: service)
        await model.load(
            route: NativeRoute(
                path: "/ai-chat", query: [.init(name: "c", value: "a"), .init(name: "keep", value: "yes")]))
        var route: NativeRoute?
        model.didReplaceRoute = { route = $0 }
        model.draft = "unsent"
        model.setMode(.investigation)
        #expect(model.draft == "unsent")
        #expect(route?.value("keep") == "yes")
        model.setMode(.chat)
        model.modelOverride = "override"
        model.useTools = false
        let digest = Task { await model.digest(prompt: "localized digest") }
        await service.waitForStream("a")
        #expect(await service.requests.last?.model == "override")
        #expect(await service.requests.last?.useTools == true)
        #expect(await service.requests.last?.insightsPreCall == true)
        model.stop()
        await digest.value
        model.modelOverride = "new selection"
        let retry = Task { await model.retryLastTurn() }
        await service.waitForStream("a", count: 2)
        #expect(await service.requests.last?.model == "override")
        #expect(await service.requests.last?.retryLastTurn == true)
        model.stop()
        await retry.value
    }
    @Test func statusCadenceModelsAndPreferencesKeepSourcePrecedenceAndResetOnlyPageDraft() async throws {
        let service = ChatFixtureService()
        let model = AIChatModel(service: service)
        model.configure(settings: .init(aiDefaultModel: "app-model"))
        await model.load(route: NativeRoute(path: "/ai-chat"))
        #expect(model.activeModel == "app-model")
        #expect(model.statusPollInterval == 30)
        #expect(await service.modelReads == 1)
        await model.select(id: "a")
        #expect(model.activeModel == "conversation-model")
        model.modelOverride = "override"
        #expect(model.activeModel == "override")
        await service.setStatus(ok: false, enabled: true)
        await model.retryStatus()
        #expect(model.statusPollInterval == 120)
        #expect(await service.modelReads == 1)
        await service.setStatus(ok: false, enabled: false)
        await model.retryStatus()
        #expect(model.statusPollInterval == nil)
        model.draft = "draft"
        model.useTools = false
        model.didDisappear()
        #expect(model.draft.isEmpty && model.modelOverride == nil && model.useTools)
        #expect(model.status?.enabled == false)
    }
    @Test func automaticThirtySecondStatusPollsRespectSixtySecondModelCacheButRetryInvalidatesBoth() async throws {
        let service = ChatFixtureService()
        let clock = ChatFixtureClock()
        let model = AIChatModel(service: service, now: { clock.date })
        await model.load(route: NativeRoute(path: "/ai-chat"))
        #expect(await service.modelReads == 1)
        clock.advance(30)
        await model.pollStatus()
        #expect(await service.modelReads == 1)
        clock.advance(30)
        await model.pollStatus()
        #expect(await service.modelReads == 2)
        await model.retryStatus()
        #expect(await service.modelReads == 3)
    }
    @Test func coordinatorOfflineGatesBothStatusLanesButKeepsManualDocumentReadAndRetiresRefresh() async throws {
        let transport = ChatWireTransport()
        let screens = AIChatScreens(
            client: APIClient(baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0)
        )
        screens.isOnline = false
        await screens.load(route: NativeRoute(path: "/ai-chat"))
        let requests = await transport.recorded
        #expect(!screens.chat.isOnline)
        #expect(requests.map(\.url.path) == ["/api/ai-research/documents"])
        screens.didDisappear()
        await screens.refresh(route: NativeRoute(path: "/ai-chat"))
        #expect(await transport.recorded.count == requests.count)
    }
    @Test func cancelledCoordinatorEntryDoesNotStartLatePageReadsOrReactivateChildren() async throws {
        let transport = ChatWireTransport()
        let screens = AIChatScreens(
            client: APIClient(baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0)
        )
        let entering = Task { await screens.load(route: NativeRoute(path: "/ai-chat")) }
        entering.cancel()
        screens.didDisappear()
        await entering.value
        #expect(await transport.recorded.isEmpty)
    }
    @Test func sameVisitModeAndSelectionUpdateOnlyChangedDetailWhileExplicitRefreshUsesStaleCaches() async throws {
        let service = ChatFixtureService()
        let clock = ChatFixtureClock()
        let model = AIChatModel(service: service, now: { clock.date })
        let route = NativeRoute(path: "/ai-chat", query: [.init(name: "c", value: "a")])
        await model.load(route: route)
        clock.advance(61)
        await model.load(route: route.setting("mode", to: "investigation"))
        #expect(await service.statusReads == 1)
        #expect(await service.modelReads == 1)
        #expect(await service.offsets == [0])
        #expect(await service.detailReads == ["a"])
        await model.load(route: route.setting("c", to: "b"))
        #expect(await service.detailReads == ["a", "b"])
        #expect(await service.statusReads == 1)
        #expect(await service.offsets == [0])
        await model.select(id: "b")
        #expect(await service.detailReads == ["a", "b"])
        await model.refreshPageReads()
        #expect(await service.statusReads == 2)
        #expect(await service.modelReads == 2)
        #expect(await service.offsets == [0, 0])
        model.didDisappear()
        clock.advance(61)
        await model.refreshPageReads()
        #expect(await service.statusReads == 2)
        await model.load(route: route)
        #expect(await service.statusReads == 3)
    }
    @Test func sendWaitingForCreationSurvivesLeaveWithoutSelectingOrClearingNewContext() async throws {
        let service = ChatFixtureService()
        let model = AIChatModel(service: service)
        await model.load(route: NativeRoute(path: "/ai-chat"))
        await service.pauseCreate()
        model.draft = "original request"
        let sending = Task { await model.send() }
        await service.waitForCreate()
        model.didDisappear()
        await model.load(route: NativeRoute(path: "/ai-chat", query: [.init(name: "c", value: "b")]))
        model.draft = "new page draft"
        await service.releaseCreate()
        await service.waitForStream("created")
        #expect(model.selectedID == "b")
        #expect(model.draft == "new page draft")
        #expect(await service.requests.last?.conversationID == "created")
        #expect(await service.requests.last?.message == "original request")
        model.streams.stop(id: "created")
        await sending.value
    }
    @Test func lateConversationReadCannotReplaceNewSelectionOrMergeMessagesIntoWrongID() async throws {
        let service = ChatFixtureService()
        let model = AIChatModel(service: service)
        await model.load(route: NativeRoute(path: "/ai-chat"))
        await service.pauseDetail("a")
        let old = Task { await model.select(id: "a") }
        await service.waitForDetail()
        await model.select(id: "b")
        await service.releaseDetail()
        await old.value
        #expect(model.selectedID == "b")
        #expect(model.detail?.conversation.id == "b")
        #expect(model.streams.details["a"] == nil)
    }
    @Test func sourcePagesUseFiftyAndNextActualOffsetAndEmptyPageStopsPagination() async throws {
        let service = ChatFixtureService()
        await service.setPagedList()
        let model = AIChatModel(service: service)
        await model.load(route: NativeRoute(path: "/ai-chat"))
        #expect(model.conversations.count == 50 && model.hasMore)
        await model.loadMore()
        #expect(model.conversations.count == 51 && !model.hasMore)
        #expect(await service.offsets == [0, 50])
    }
    @Test func deleteStopsItsStreamDeselectsBeforeRequestAndFailedRenameKeepsServerRefresh() async throws {
        let service = ChatFixtureService()
        let model = AIChatModel(service: service)
        await model.load(route: NativeRoute(path: "/ai-chat", query: [.init(name: "c", value: "a")]))
        model.draft = "message"
        let turn = Task { await model.send() }
        await service.waitForStream("a")
        #expect(await model.delete(id: "a"))
        await turn.value
        #expect(model.selectedID == nil)
        #expect(model.streams.snapshot(id: "a").status == .idle)
        #expect(await service.deleted == ["a"])
    }
}
private func fixtureConversation(_ id: String) -> TaxValue {
    .object([
        "id": .string(id), "title": .string("Title " + id), "model": .string("conversation-model"),
        "updatedAt": .string("2026-01-01T00:00:00Z"),
    ])
}
private func chatMessage(_ id: String, role: String, content: String) -> TaxValue {
    .object([
        "id": .string(id), "role": .string(role), "content": .string(content),
        "createdAt": .string("2026-01-01T00:00:00Z"),
    ])
}
private func chatDetail(_ id: String, messages: [TaxValue] = []) throws -> AIChatConversationDetail {
    .init(conversation: try .init(raw: fixtureConversation(id)), messages: try messages.map { try .init(raw: $0) })
}
private func chatComplete(_ id: String, assistant: String) -> TaxValue {
    .object([
        "conversation": fixtureConversation(id),
        "assistantMessage": chatMessage(assistant, role: "assistant", content: "answer"),
        "usage": .object(["evalCount": .null]), "iterations": .number(1),
    ])
}
@MainActor private func waitUntil(_ predicate: () -> Bool) async {
    for _ in 0..<2000 {
        if predicate() { return }
        try? await Task.sleep(for: .milliseconds(1))
    }
    Issue.record("Expected asynchronous state did not arrive")
}
private actor ChatWatchdogClock {
    private enum Counter: Equatable { case sleeps, cancellations }
    private struct Waiter {
        var counter: Counter
        var target: Int
        var continuation: CheckedContinuation<Void, Error>
    }
    private var pending: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var latest: UUID?
    private var cancellations = 0
    private var waiters: [UUID: Waiter] = [:]
    private(set) var intervals: [UInt64] = []
    var pendingCount: Int { pending.count }

    func sleep(_ nanoseconds: UInt64) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                intervals.append(nanoseconds)
                pending[id] = continuation
                latest = id
                resolveWaiters()
            }
        } onCancel: {
            Task { await self.cancelSleep(id) }
        }
    }
    func waitForSleeps(_ target: Int) async throws { try await wait(for: .sleeps, target: target) }
    func waitForCancellations(_ target: Int) async throws { try await wait(for: .cancellations, target: target) }
    func expireCurrentSleep() {
        guard let latest, let continuation = pending.removeValue(forKey: latest) else {
            preconditionFailure("Expected an armed watchdog")
        }
        continuation.resume()
    }
    private func cancelSleep(_ id: UUID) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        cancellations += 1
        continuation.resume(throwing: CancellationError())
        resolveWaiters()
    }
    private func reached(_ counter: Counter, target: Int) -> Bool {
        (counter == .sleeps ? intervals.count : cancellations) >= target
    }
    private func wait(for counter: Counter, target: Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                if reached(counter, target: target) {
                    continuation.resume()
                } else {
                    waiters[id] = .init(counter: counter, target: target, continuation: continuation)
                }
            }
        } onCancel: {
            Task { await self.cancelWaiter(id) }
        }
    }
    private func cancelWaiter(_ id: UUID) {
        waiters.removeValue(forKey: id)?.continuation.resume(throwing: CancellationError())
    }
    private func resolveWaiters() {
        let ready = waiters.filter { reached($0.value.counter, target: $0.value.target) }
        for (id, waiter) in ready {
            waiters[id] = nil
            waiter.continuation.resume()
        }
    }
}

private actor ChatFixtureService: AIChatService {
    var requests: [AIChatSendRequest] = []
    var deleted: [AiConversationID] = []
    var modelReads = 0
    var statusReads = 0
    var detailReads: [AiConversationID] = []
    var offsets: [Int] = []
    private var ok = true
    private var enabled = true
    private var details: [AiConversationID: AIChatConversationDetail] = [:]
    private var paged = false
    private var pipes: [AiConversationID: AsyncThrowingStream<ServerSentEvent, Error>.Continuation] = [:]
    private var streamCounts: [AiConversationID: Int] = [:]
    private var streamWaiters: [AiConversationID: [(count: Int, continuation: CheckedContinuation<Void, Never>)]] = [:]
    private var createWaiter: CheckedContinuation<Void, Never>?
    private var detailWaiter: CheckedContinuation<Void, Never>?
    private var createPaused = false
    private var createGate: CheckedContinuation<Void, Never>?
    private var detailPauseID: AiConversationID?
    private var detailGate: CheckedContinuation<Void, Never>?
    func setStatus(ok: Bool, enabled: Bool) {
        self.ok = ok
        self.enabled = enabled
    }
    func setDetail(_ detail: AIChatConversationDetail) { details[detail.conversation.id] = detail }
    func setPagedList() { paged = true }
    func pauseDetail(_ id: AiConversationID) { detailPauseID = id }
    func waitForDetail() async {
        if detailGate != nil { return }
        await withCheckedContinuation { detailWaiter = $0 }
    }
    func releaseDetail() {
        detailGate?.resume()
        detailGate = nil
    }
    func chatStatus() async throws -> AIChatOllamaStatus {
        statusReads += 1
        return try .init(
            raw: .object([
                "ok": .bool(ok), "enabled": .bool(enabled), "baseUrl": .string("http://local.invalid"),
                "defaultModel": .string("status-model"),
            ]))
    }
    func chatModels() async throws -> [AIChatOllamaModel] {
        modelReads += 1
        return [try .init(raw: .object(["name": .string("available"), "size": .null]))]
    }
    func chatConversations(offset: Int) async throws -> AIChatConversationPage {
        offsets.append(offset)
        let ids: [AiConversationID] =
            paged
            ? (offset == 0 ? (0..<50).map { AiConversationID("id\($0)") } : ["id50"])
            : ["a", "b"].filter { !deleted.contains($0) }
        return .init(
            items: try ids.map { try .init(raw: fixtureConversation($0.rawValue)) }, total: paged ? 51 : ids.count, limit: 50,
            offset: offset)
    }
    func chatConversation(id: AiConversationID) async throws -> AIChatConversationDetail {
        detailReads.append(id)
        let value = try details[id] ?? chatDetail(id.rawValue)
        if detailPauseID == id {
            detailPauseID = nil
            await withCheckedContinuation {
                detailGate = $0
                detailWaiter?.resume()
                detailWaiter = nil
            }
        }
        return value
    }
    func pauseCreate() { createPaused = true }
    func waitForCreate() async {
        if createGate != nil { return }
        await withCheckedContinuation { createWaiter = $0 }
    }
    func releaseCreate() {
        createGate?.resume()
        createGate = nil
    }
    func chatCreate(model: String?) async throws -> AIChatConversationDetail {
        if createPaused {
            createPaused = false
            await withCheckedContinuation {
                createGate = $0
                createWaiter?.resume()
                createWaiter = nil
            }
        }
        return try chatDetail("created")
    }
    func chatRename(id: AiConversationID, title: String) async throws -> AIChatConversation {
        try .init(raw: fixtureConversation(id.rawValue))
    }
    func chatDelete(id: AiConversationID) async throws { deleted.append(id) }
    func chatStream(_ request: AIChatSendRequest, onEvent: @escaping @Sendable (AIChatEvent) async -> Void) async throws
        -> AIChatComplete
    {
        requests.append(request)
        let (stream, continuation) = AsyncThrowingStream<ServerSentEvent, Error>.makeStream()
        pipes[request.conversationID] = continuation
        streamCounts[request.conversationID, default: 0] += 1
        let count = streamCounts[request.conversationID, default: 0]
        let waiters = streamWaiters[request.conversationID] ?? []
        streamWaiters[request.conversationID] = waiters.filter { $0.count > count }
        for waiter in waiters where waiter.count <= count { waiter.continuation.resume() }
        return try await AIChatStreamReader().read(onEvent: onEvent) { receive in
            for try await frame in stream { try await receive(frame) }
        }
    }
    func waitForStream(_ id: AiConversationID, count: Int = 1) async {
        if streamCounts[id, default: 0] >= count { return }
        await withCheckedContinuation { streamWaiters[id, default: []].append((count, $0)) }
    }
    func push(_ id: AiConversationID, event: String, raw: TaxValue) throws {
        pipes[id]?.yield(.init(event: event, data: String(decoding: try APIBody.encode(raw), as: UTF8.self)))
    }
    func finish(_ id: AiConversationID) { pipes[id]?.finish() }
}

private final class ChatFixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_767_225_600)
    var date: Date {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
    func advance(_ seconds: TimeInterval) {
        lock.lock()
        defer { lock.unlock() }
        value = value.addingTimeInterval(seconds)
    }
}

private actor ChatWireTransport: APITransport {
    var recorded: [APIRequest] = []
    func send(_ request: APIRequest) async throws -> APIResponse {
        recorded.append(request)
        let data: TaxValue
        if request.url.path == "/api/ai/status" {
            data = .object([
                "ok": .bool(true), "enabled": .bool(true), "baseUrl": .string("http://local.invalid"),
                "defaultModel": .string("default"),
            ])
        } else if request.url.path == "/api/ai-research/documents" {
            data = .object(["items": .array([]), "total": .number(0)])
        } else if request.url.path == "/api/ai/models" {
            data = .object([
                "items": .array([.object(["name": .string("model"), "size": .null])]), "total": .number(1),
            ])
        } else if request.method == .delete {
            data = .null
        } else if request.method == .patch {
            data = fixtureConversation("a")
        } else if request.url.path == "/api/ai/conversations", request.method == .get {
            data = .object(["items": .array([]), "total": .number(51), "limit": .number(50), "offset": .number(50)])
        } else {
            data = .object(["conversation": fixtureConversation("a"), "messages": .array([])])
        }
        return .init(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": data])))
    }
}
