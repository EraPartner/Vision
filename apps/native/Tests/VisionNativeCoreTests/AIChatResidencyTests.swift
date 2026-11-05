import Foundation
import Testing

@testable import VisionNativeCore

/// `useModelResidency` (apps/frontend/src/hooks/useModelResidency.test.tsx) and the model-fit /
/// warm / release requests of ADR-248.
@Suite("AI chat model residency and memory fit") @MainActor
struct AIChatResidencyTests {
    @Test func warmsAfterTwoSecondsThenEveryFourMinutesWhileForeground() async {
        let (service, gate, residency) = fixture()
        residency.update(model: "m", ollamaOK: true)
        await gate.waitUntilSleeping(1)
        #expect(await gate.requested == [.seconds(2)])
        #expect(await service.warms.isEmpty)
        await gate.tick()
        await eventually { await service.warms == ["m"] }
        await gate.waitUntilSleeping(1)
        #expect(await gate.requested.last == .seconds(240))
        residency.isForeground = false
        await gate.tick()
        await gate.waitUntilSleeping(1)
        try? await Task.sleep(for: .milliseconds(30))
        #expect(await service.warms == ["m"])
        residency.isForeground = true
        await gate.tick()
        await eventually { await service.warms == ["m", "m"] }
        residency.stop()
    }

    @Test func releasesOnStopOnlyWhenTheModelWasWarmed() async {
        let (service, gate, residency) = fixture()
        residency.update(model: "m", ollamaOK: true)
        await gate.waitUntilSleeping(1)
        residency.stop()
        try? await Task.sleep(for: .milliseconds(30))
        #expect(await service.releases.isEmpty && residency.target == nil)

        residency.update(model: "m", ollamaOK: true)
        await gate.waitUntilSleeping(1)
        await gate.tick()
        await eventually { await service.warms == ["m"] }
        residency.stop()
        await eventually { await service.releases == ["m"] }
        // The cancelled loop does not warm again.
        await gate.tick()
        try? await Task.sleep(for: .milliseconds(30))
        #expect(await service.warms == ["m"])
    }

    @Test func aModelChangeReleasesThePreviousModelAndWarmsTheNext() async {
        let (service, gate, residency) = fixture()
        residency.update(model: "a", ollamaOK: true)
        await gate.waitUntilSleeping(1)
        await gate.tick()
        await eventually { await service.warms == ["a"] }
        residency.update(model: "b", ollamaOK: true)
        await eventually { await service.releases == ["a"] }
        #expect(residency.target == "b")
        await gate.waitUntilSleeping(1)
        await gate.tick()
        await eventually { await service.warms == ["a", "b"] }
        residency.stop()
    }

    @Test func anUnchangedTargetDoesNothing() async {
        let (_, gate, residency) = fixture()
        residency.update(model: "m", ollamaOK: true)
        residency.update(model: "m", ollamaOK: true)
        await gate.waitUntilSleeping(1)
        #expect(await gate.requested == [.seconds(2)])
        residency.stop()
    }

    @Test func theAppleModelAMissingModelAndAnUnreachableOllamaAreSkipped() async {
        let (service, gate, residency) = fixture()
        residency.update(model: appleFoundationModel, ollamaOK: true)
        residency.update(model: nil, ollamaOK: true)
        residency.update(model: "m", ollamaOK: false)
        #expect(residency.target == nil)
        try? await Task.sleep(for: .milliseconds(30))
        #expect(await gate.requested.isEmpty)
        #expect(await service.warms.isEmpty)
        #expect(await service.releases.isEmpty)
    }

    @Test func theChatPageWarmsItsActiveModelAndReleasesItOnLeave() async {
        let (service, gate, _) = fixture()
        let model = AIChatModel(service: service, sleep: { try await gate.sleep($0) })
        await model.load(route: NativeRoute(path: "/ai-chat"))
        #expect(model.residency.target == "status-model")
        await gate.waitUntilSleeping(1)
        await gate.tick()
        await eventually { await service.warms == ["status-model"] }
        // The default model in Settings becomes the Apple model: nothing stays resident.
        var settings = NativeAppSettings.defaults
        settings.aiDefaultModel = appleFoundationModel
        model.configure(settings: settings)
        #expect(model.residency.target == nil)
        await eventually { await service.releases == ["status-model"] }
        settings.aiDefaultModel = "chosen"
        model.configure(settings: settings)
        #expect(model.residency.target == "chosen")
        model.didDisappear()
        #expect(model.residency.target == nil)
    }

    @Test func modelFitReadsGetWithTheModelQueryAndResidencySendsPostBodies() async throws {
        let transport = ResidencyWireTransport()
        let client = APIClient(
            baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0)
        let fit = try await client.chatModelFit(model: "llama3.1:8b")
        try await client.chatWarm(model: "llama3.1:8b")
        try await client.chatRelease(model: "llama3.1:8b")
        #expect(fit.totalMemoryBytes == 17_179_869_184 && fit.weightBytes == nil)
        let requests = await transport.recorded
        #expect(requests.map(\.method) == [.get, .post, .post])
        #expect(requests.map(\.url.path) == ["/api/ai/model/fit", "/api/ai/model/warm", "/api/ai/model/release"])
        let query = URLComponents(url: requests[0].url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query == [.init(name: "model", value: "llama3.1:8b")])
        for request in requests.dropFirst() {
            #expect(
                try JSONDecoder().decode(TaxValue.self, from: #require(request.body))
                    == .object(["model": .string("llama3.1:8b")]))
        }
    }

    @Test func theMemoryAdvisorLineUsesOneDecimalGigabytesAndRoundsTheTotal() {
        let gib = 1 << 30
        let fit = OpenAPI.AiModelFit(
            model: "llama3.1:8b", totalMemoryBytes: 16 * gib, weightBytes: Int(4.9 * Double(gib)),
            kvBytesPerToken: 128 * 1024, maxNumCtx: 16_384)
        #expect(
            NativeSettingsAIModel.fitVariables(fit) == ["weights": "4.9", "context": "2.0", "total": "16"])
        // Any null field hides the line, as when Ollama cannot report the model's size.
        let unknown = OpenAPI.AiModelFit(model: "m", totalMemoryBytes: 16 * gib)
        #expect(NativeSettingsAIModel.fitVariables(unknown) == nil)
    }

    @Test func theSettingsAdvisorLoadsForTheSelectedModelAndSkipsTheAppleModel() async throws {
        let service = FitSettingsService()
        let model = NativeSettingsAIModel(service: service)
        model.configure(appRaw: nil)
        await model.load()
        await model.settleFit()
        #expect(model.fitVariables == ["weights": "4.9", "context": "2.0", "total": "16"])
        #expect(await service.fitModels == ["status-model"])
        model.configure(appRaw: .object(["aiDefaultModel": .string(appleFoundationModel)]))
        #expect(model.fitVariables == nil)
        await model.settleFit()
        #expect(await service.fitModels == ["status-model"])
        model.didDisappear()
    }

    private func fixture() -> (ResidencyService, SleepGate, AIChatResidency) {
        let service = ResidencyService()
        let gate = SleepGate()
        return (service, gate, AIChatResidency(service: service, sleep: { try await gate.sleep($0) }))
    }

    private func eventually(_ condition: @escaping () async -> Bool) async {
        for _ in 0..<400 {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("condition not reached")
    }
}

/// A sleep that returns only when the test ticks it. Like `Task.sleep`, a cancelled sleeper throws
/// at once and leaves the queue, so a tick always reaches a live loop.
private actor SleepGate {
    private(set) var requested: [Duration] = []
    private var waiters: [(id: UUID, continuation: CheckedContinuation<Void, Error>)] = []
    func sleep(_ duration: Duration) async throws {
        requested.append(duration)
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiters.append((id, continuation))
                }
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }
    private func cancel(_ id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: index).continuation.resume(throwing: CancellationError())
    }
    func tick() {
        guard !waiters.isEmpty else { return }
        waiters.removeFirst().continuation.resume()
    }
    func waitUntilSleeping(_ count: Int) async {
        for _ in 0..<400 {
            if waiters.count >= count { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }
}

private actor ResidencyService: AIChatService {
    private(set) var warms: [String] = []
    private(set) var releases: [String] = []
    func chatWarm(model: String) async throws { warms.append(model) }
    func chatRelease(model: String) async throws { releases.append(model) }
    func chatStatus() async throws -> AIChatOllamaStatus {
        try .init(
            raw: .object([
                "ok": .bool(true), "enabled": .bool(true), "baseUrl": .string("http://local.invalid"),
                "defaultModel": .string("status-model"),
            ]))
    }
    func chatModels() async throws -> [AIChatOllamaModel] { [] }
    func chatConversations(offset: Int) async throws -> AIChatConversationPage {
        .init(items: [], total: 0, limit: 50, offset: offset)
    }
    func chatConversation(id: AiConversationID) async throws -> AIChatConversationDetail {
        throw APIError.backendUnavailable
    }
    func chatCreate(model: String?) async throws -> AIChatConversationDetail { throw APIError.backendUnavailable }
    func chatRename(id: AiConversationID, title: String) async throws -> AIChatConversation {
        throw APIError.backendUnavailable
    }
    func chatDelete(id: AiConversationID) async throws {}
    func chatStream(_ request: AIChatSendRequest, onEvent: @escaping @Sendable (AIChatEvent) async -> Void)
        async throws -> AIChatComplete
    {
        throw APIError.backendUnavailable
    }
}

private actor ResidencyWireTransport: APITransport {
    var recorded: [APIRequest] = []
    func send(_ request: APIRequest) async throws -> APIResponse {
        recorded.append(request)
        let data: TaxValue =
            request.url.path == "/api/ai/model/fit"
            ? .object([
                "model": .string("llama3.1:8b"), "totalMemoryBytes": .number(17_179_869_184),
                "weightBytes": .null, "kvBytesPerToken": .null, "maxNumCtx": .null,
            ]) : .null
        return .init(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": data])))
    }
}

private actor FitSettingsService: NativeSettingsAIService {
    private(set) var fitModels: [String] = []
    func settingsAIStatus() async throws -> AIChatOllamaStatus {
        try .init(
            raw: .object([
                "ok": .bool(true), "enabled": .bool(true), "baseUrl": .string("http://local.invalid"),
                "defaultModel": .string("status-model"),
            ]))
    }
    func settingsAIModels() async throws -> [AIChatOllamaModel] { [] }
    func settingsAIModelFit(model: String) async throws -> OpenAPI.AiModelFit {
        fitModels.append(model)
        let gib = 1 << 30
        return .init(
            model: model, totalMemoryBytes: 16 * gib, weightBytes: Int(4.9 * Double(gib)),
            kvBytesPerToken: 128 * 1024, maxNumCtx: 16_384)
    }
    func settingsAIProviderKeys() async throws -> NativeSettingsAIProviderStatuses {
        try .init(raw: .object(["items": .array([]), "total": .number(0)]))
    }
    func settingsAISetProviderKey(provider: String, input: String) async throws -> NativeSettingsAIProviderStatuses {
        try await settingsAIProviderKeys()
    }
    func settingsAIClearProviderKey(provider: String) async throws {}
}
