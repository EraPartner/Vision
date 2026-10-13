import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("AI Settings source preferences, shared receipts and mutation authority")
struct NativeSettingsAITests {
    @Test func modelSelectionsRetainIndependentRawPresenceAndSourceFallbacks() async throws {
        let service = SettingsAIFixtureService()
        let model = NativeSettingsAIModel(service: service)
        model.configure(
            appRaw: .object(["aiDefaultModel": .string("unknown-local"), "openAiDefaultModel": .string("invalid")]))
        await model.load()
        #expect(model.selectedLocalModel == "unknown-local")
        #expect(model.selectedOpenAiModel == "server-absent-from-catalog")
        #expect(model.selectedAnswerDepth == "product-default")
        model.configure(
            appRaw: .object([
                "aiDefaultModel": .string(""), "openAiDefaultModel": .string("allowed"),
                "aiAnswerDepth": .string("detailed"),
            ]))
        #expect(model.selectedLocalModel == "" && model.selectedOpenAiModel == "allowed")
        #expect(model.selectedAnswerDepth == "detailed")
        model.didDisappear()
    }
    @Test func benchmarkBlurNormalizesOnlyValidDraftAndClearRemovesPresence() {
        let model = NativeSettingsAIModel(service: SettingsAIFixtureService())
        model.updateBenchmarkDraft(" \u{FEFF}acwi.us \u{FEFF}")
        var edit: TaxValue? = .string("old")
        model.commitBenchmark { edit = $0 }
        #expect(edit == .string("ACWI.US") && !model.benchmarkError)
        model.updateBenchmarkDraft("invalid value")
        model.commitBenchmark { edit = $0 }
        #expect(edit == .string("ACWI.US") && model.benchmarkDraft == "invalid value" && model.benchmarkError)
        model.clearBenchmark { edit = $0 }
        #expect(edit == nil && model.benchmarkDraft.isEmpty && !model.benchmarkError)
        model.updateBenchmarkDraft(String(repeating: "A", count: 40))
        #expect(model.benchmarkDraft.utf16.count == 32)
        #expect(NativeSettingsAIText.trim("\u{FEFF}x\u{FEFF}") == "x")
        #expect(NativeSettingsAIText.trim("\u{0085}") == "\u{0085}")
    }
    @Test func freshReceiptsSkipSharedReadsAndOnlyNewerSeedsReplace() async throws {
        let service = SettingsAIFixtureService()
        let date = Date(timeIntervalSince1970: 100)
        let model = NativeSettingsAIModel(service: service, now: { date })
        let status = try settingsAIStatusFixture()
        let models = [try AIChatOllamaModel(raw: .object(["name": .string("local")]))]
        let research = try settingsAIResearch()
        model.seedSharedStatus(status, fetchedAt: date)
        model.seedSharedModels(models, fetchedAt: date)
        model.seedSharedResearch(research, fetchedAt: date)
        await model.load()
        let reads = await service.counts()
        #expect(reads.status == 0 && reads.models == 0 && reads.research == 0)
        model.seedSharedStatus(try settingsAIStatusFixture(ok: false), fetchedAt: date.addingTimeInterval(-1))
        #expect(model.ollamaStatus?.ok == true)
        model.seedSharedStatus(try settingsAIStatusFixture(ok: false), fetchedAt: date.addingTimeInterval(1))
        #expect(model.ollamaStatus?.ok == false)
        model.didDisappear()
    }
    @Test func newerSiblingReceiptsResolvePausedSharedQueriesWithoutAForcedReread() async throws {
        let service = SettingsAIFixtureService()
        let date = Date(timeIntervalSince1970: 100)
        let model = NativeSettingsAIModel(service: service, now: { date })
        model.isOnline = false
        model.isForeground = false
        await model.load()
        model.seedSharedStatus(try settingsAIStatusFixture(), fetchedAt: date)
        model.seedSharedModels([], fetchedAt: date)
        model.seedSharedResearch(try settingsAIResearch(), fetchedAt: date)
        model.isOnline = true
        model.isForeground = true
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while (model.providerStatuses == nil || model.desktopStatus == nil) && ContinuousClock.now < deadline {
            await Task.yield()
        }
        let reads = await service.counts()
        #expect(reads.status == 0 && reads.models == 0 && reads.research == 0)
        #expect(reads.providers == 1 && reads.desktop == 1)
        model.didDisappear()
    }
    @Test func saveClearsImmediatelyOnFailureWithoutLeakingTheErrorAndDoesNotClearEnv() async throws {
        let service = SettingsAIFixtureService()
        await service.setSaveFailure(true)
        let model = NativeSettingsAIModel(service: service)
        await model.load()
        var notices: [String] = []
        model.didNotice = { notices.append($0) }
        model.setKeyInput("env", " \u{FEFF}synthetic-input\u{FEFF} ")
        let task = Task { await model.saveProviderKey("env") }
        await service.waitForWrite()
        #expect(model.keyInput("env").isEmpty)
        #expect(!model.canSaveKey("settings") && !model.canClearKey("env"))
        #expect(model.canClearKey("settings"))
        model.setKeyInput("env", "next-draft")
        await service.releaseWrite()
        await task.value
        #expect(notices == ["settings.research.saveFailed"])
        #expect(model.keyInput("env") == "next-draft")
        #expect(await service.savedInput() == "synthetic-input")
        await model.clearProviderKey("env")
        #expect(await service.clearCount() == 0)
        model.didDisappear()
    }
    @Test func offlineSubmittedMutationWaitsForFocusedReconnectAfterPaneUnmount() async throws {
        let service = SettingsAIFixtureService()
        let model = NativeSettingsAIModel(service: service)
        await model.load()
        model.isOnline = false
        model.isForeground = false
        model.setKeyInput("settings", "synthetic")
        let write = Task { await model.saveProviderKey("settings") }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !model.isSavingKey && ContinuousClock.now < deadline { await Task.yield() }
        #expect(model.isSavingKey && model.keyInput("settings").isEmpty)
        #expect(await service.savedInput() == nil)
        model.didDisappear()
        model.isOnline = true
        await Task.yield()
        #expect(await service.savedInput() == nil)
        model.isForeground = true
        await service.waitForWrite()
        await service.releaseWrite()
        await write.value
        #expect(await service.savedInput() == "synthetic")
    }
    @Test func lateAgentCloakAcknowledgmentRefreshesCurrentVisitAndInvalidatesOnlyItsKeys() async throws {
        let service = SettingsAIFixtureService()
        let model = NativeSettingsAIModel(service: service)
        await model.load()
        var invalidations: [[String]] = []
        model.didInvalidateSharedReads = { invalidations.append($0) }
        let write = Task { await model.toggleAgentCloak() }
        await service.waitForWrite()
        model.didDisappear()
        await model.load()
        let before = await service.counts()
        await service.releaseWrite()
        await write.value
        let after = await service.counts()
        #expect(after.desktop == before.desktop + 1 && after.research == before.research + 1)
        #expect(model.desktopStatus?.enabled == true)
        #expect(invalidations == [["agentcloak-desktop", "openai-research-status"]])
        model.didDisappear()
    }
    @Test func failedOldToggleDoesNotRetireAReenteredDesktopRead() async throws {
        let service = SettingsAIFixtureService()
        let model = NativeSettingsAIModel(service: service)
        await model.load()
        await service.setDesktopWriteFailure(true)
        let write = Task { await model.toggleAgentCloak() }
        await service.waitForWrite()
        model.didDisappear()
        await model.load()
        await service.gateNextDesktopRead()
        let read = Task { await model.checkAgentCloak() }
        await service.waitForDesktopRead()
        await service.releaseWrite()
        await write.value
        #expect(model.isFetchingDesktop && model.desktopMutationError == nil)
        await service.releaseDesktopRead()
        await read.value
        #expect(!model.isFetchingDesktop && model.desktopStatus?.enabled == false)
        model.didDisappear()
    }
    @Test func modelsStartAfterHealthyStatusWithoutWaitingForOtherStatusQueries() async throws {
        let service = SettingsAIFixtureService()
        await service.gateNextDesktopRead()
        let model = NativeSettingsAIModel(service: service)
        let load = Task { await model.load() }
        await service.waitForDesktopRead()
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while await service.counts().models == 0 && ContinuousClock.now < deadline { await Task.yield() }
        #expect(await service.counts().models == 1)
        #expect(model.ollamaModels?.first?.name == "local")
        await service.releaseDesktopRead()
        await load.value
        model.didDisappear()
    }
    @Test func onlineBackgroundMountReadsButFocusAloneDoesNotRefreshExpiredQueries() async throws {
        let service = SettingsAIFixtureService()
        let clock = SettingsAIClock(Date(timeIntervalSince1970: 100))
        let model = NativeSettingsAIModel(service: service, now: { clock.value() })
        model.isForeground = false
        await model.load()
        let first = await service.counts()
        #expect(first.status == 1 && first.models == 1 && first.research == 1)
        clock.advance(200)
        model.isForeground = true
        await Task.yield()
        #expect(await service.counts() == first)
        #expect(model.statusPollInterval == 30)
        model.seedSharedStatus(try settingsAIStatusFixture(ok: false), fetchedAt: clock.value())
        #expect(model.statusPollInterval == 120)
        model.seedSharedStatus(
            try settingsAIStatusFixture(ok: false, enabled: false), fetchedAt: clock.value().addingTimeInterval(1))
        #expect(model.statusPollInterval == nil)
        model.didDisappear()
    }
    @Test func providerRetryKeepsSourceDelayAndWaitsForFocusToContinueBackgroundFailure() async throws {
        let service = SettingsAIFixtureService()
        await service.setProviderFailures(1)
        let delays = SleepRecorder()
        let model = NativeSettingsAIModel(service: service, sleep: { await delays.record($0) })
        model.isForeground = false
        await model.load()
        #expect(await service.counts().providers == 1)
        #expect(model.providerStatuses == nil)
        #expect(await delays.delays == [.seconds(1)])
        model.isForeground = true
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while model.providerStatuses == nil && ContinuousClock.now < deadline { await Task.yield() }
        #expect(model.providerStatuses?.total == 2)
        #expect(await service.counts().providers == 2)
        #expect(await delays.delays == [.seconds(1)])
        model.didDisappear()
    }
    @Test func actualReadsPublishReceiptsWithoutEchoingSeededSnapshots() async throws {
        let service = SettingsAIFixtureService()
        let model = NativeSettingsAIModel(service: service)
        var statusReads = 0
        var modelReads = 0
        var researchReads = 0
        model.didReceiveStatus = { _ in statusReads += 1 }
        model.didReceiveModels = { _ in modelReads += 1 }
        model.didReceiveResearch = { _ in researchReads += 1 }
        await model.load()
        #expect(statusReads == 1 && modelReads == 1 && researchReads == 1)
        let receipt = try #require(model.sharedStatusReceipt)
        model.seedSharedStatus(receipt.value, fetchedAt: receipt.fetchedAt.addingTimeInterval(1))
        #expect(statusReads == 1)
        model.didDisappear()
    }
}

private final class SettingsAIClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date: Date
    init(_ date: Date) { self.date = date }
    func value() -> Date { lock.withLock { date } }
    func advance(_ seconds: TimeInterval) { lock.withLock { date = date.addingTimeInterval(seconds) } }
}
private struct SettingsAIReadCounts: Equatable, Sendable {
    var status = 0, models = 0, research = 0, providers = 0, desktop = 0
}
private actor SettingsAIFixtureService: NativeSettingsAIService {
    private var reads = SettingsAIReadCounts()
    private var providerFailures = 0
    func setProviderFailures(_ value: Int) { providerFailures = value }
    private var saveFailure = false
    private var desktopWriteFailure = false
    private var gateDesktopRead = false
    private var desktopReadStarted = false
    private var desktopReadWaiters: [CheckedContinuation<Void, Never>] = []
    private var desktopReadFinish: CheckedContinuation<Void, Never>?
    func setDesktopWriteFailure(_ value: Bool) { desktopWriteFailure = value }
    func gateNextDesktopRead() {
        gateDesktopRead = true
        desktopReadStarted = false
    }
    func waitForDesktopRead() async {
        if desktopReadStarted { return }
        await withCheckedContinuation { desktopReadWaiters.append($0) }
    }
    func releaseDesktopRead() {
        desktopReadFinish?.resume()
        desktopReadFinish = nil
    }

    private var enabled = false
    private var input: String?
    private var clears = 0
    private var started = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var finish: CheckedContinuation<Void, Never>?
    func setSaveFailure(_ value: Bool) { saveFailure = value }
    func counts() -> SettingsAIReadCounts { reads }
    func savedInput() -> String? { input }
    func clearCount() -> Int { clears }
    func waitForWrite() async {
        if started { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }
    func releaseWrite() {
        finish?.resume()
        finish = nil
    }
    private func gatedWrite() async {
        await withCheckedContinuation { continuation in
            finish = continuation
            started = true
            for waiter in startWaiters { waiter.resume() }
            startWaiters = []
        }
    }
    func settingsAIStatus() throws -> AIChatOllamaStatus {
        reads.status += 1
        return try settingsAIStatusFixture()
    }
    func settingsAIModels() throws -> [AIChatOllamaModel] {
        reads.models += 1
        return [try .init(raw: .object(["name": .string("local")]))]
    }
    func settingsAIResearchStatus() throws -> AIResearchStatus {
        reads.research += 1
        return try settingsAIResearch()
    }
    func settingsAIProviderKeys() throws -> NativeSettingsAIProviderStatuses {
        reads.providers += 1
        if providerFailures > 0 {
            providerFailures -= 1
            throw APIError.network("synthetic provider status failure")
        }
        return try settingsAIProviders()
    }
    func settingsAISetProviderKey(provider: String, input: String) async throws -> NativeSettingsAIProviderStatuses {
        self.input = input
        await gatedWrite()
        if saveFailure { throw APIError.network("Do not display this synthetic response") }
        return try settingsAIProviders()
    }
    func settingsAIClearProviderKey(provider: String) { clears += 1 }
    func settingsAIDesktopStatus() async throws -> NativeSettingsAIAgentCloakStatus {
        reads.desktop += 1
        if gateDesktopRead {
            gateDesktopRead = false
            await withCheckedContinuation { continuation in
                desktopReadFinish = continuation
                desktopReadStarted = true
                for waiter in desktopReadWaiters { waiter.resume() }
                desktopReadWaiters = []
            }
        }
        return try settingsAIDesktop(enabled: enabled)
    }
    func settingsAIConfigureDesktop(enabled: Bool) async throws -> NativeSettingsAIAgentCloakStatus {
        await gatedWrite()
        if desktopWriteFailure { throw APIError.network("synthetic desktop failure") }
        self.enabled = enabled
        return try settingsAIDesktop(enabled: enabled)
    }
}
private func settingsAIStatusFixture(ok: Bool = true, enabled: Bool = true) throws -> AIChatOllamaStatus {
    try .init(
        raw: .object([
            "ok": .bool(ok), "enabled": .bool(enabled), "baseUrl": .string("http://fixture.invalid"),
            "defaultModel": .string("local"),
        ]))
}
private func settingsAIResearch() throws -> AIResearchStatus {
    try .init(
        raw: .object([
            "openai": .object([
                "enabled": .bool(true), "model": .string("server-absent-from-catalog"),
                "models": .array([
                    .object([
                        "id": .string("allowed"), "label": .string("Allowed"), "inputMicrosPerMillion": .number(1),
                        "outputMicrosPerMillion": .number(2), "isDefault": .bool(true),
                    ])
                ]),
            ])
        ]))
}
private func settingsAIProviders() throws -> NativeSettingsAIProviderStatuses {
    try .init(
        raw: .object([
            "total": .number(2),
            "items": .array(
                ["settings", "env"].map { source in
                    .object([
                        "provider": .string(source), "label": .string(source), "envVar": .string("FIXTURE_KEY"),
                        "configured": .bool(true), "source": .string(source), "masked": .string("***tail"),
                    ])
                }),
        ]))
}
private func settingsAIDesktop(enabled: Bool) throws -> NativeSettingsAIAgentCloakStatus {
    try .init(
        raw: .object([
            "enabled": .bool(enabled), "available": .bool(true), "mappingKeyConfigured": .bool(true),
            "openAiEnabled": .bool(true),
        ]))
}
