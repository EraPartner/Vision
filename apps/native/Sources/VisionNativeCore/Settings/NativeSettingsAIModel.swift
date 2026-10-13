import Foundation
import Observation

@MainActor @Observable public final class NativeSettingsAIModel {
    public private(set) var ollamaStatus: AIChatOllamaStatus?
    public private(set) var ollamaModels: [AIChatOllamaModel]?
    public private(set) var researchStatus: AIResearchStatus?
    public private(set) var providerStatuses: NativeSettingsAIProviderStatuses?
    public private(set) var desktopStatus: NativeSettingsAIAgentCloakStatus?
    public private(set) var desktopReadError: String?
    public private(set) var desktopMutationError: String?
    public private(set) var isSavingKey = false
    public private(set) var isClearingKey = false
    public private(set) var isTogglingDesktop = false
    public private(set) var benchmarkError = false
    public var benchmarkDraft = ""
    public var isOnline = true {
        didSet {
            if isOnline && !oldValue {
                let pending = onlineWaiters
                onlineWaiters = []
                for continuation in pending { continuation.resume() }
                if active { Task { [weak self] in await self?.reconnect() } }
            }
        }
    }
    public var isForeground = true {
        didSet {
            if isForeground && !oldValue && active && !pausedReads.isEmpty {
                Task { [weak self] in await self?.resumePausedReads() }
            }
        }
    }
    public var didNotice: (@MainActor (String) -> Void)?
    public var didInvalidateResearchStatus: (@MainActor () -> Void)?
    @ObservationIgnored private let service: any NativeSettingsAIService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var active = false
    @ObservationIgnored private var visit = UUID()
    @ObservationIgnored private var rawApp: TaxValue?
    @ObservationIgnored private var keyInputs: [String: String] = [:]
    @ObservationIgnored private var fetching: Set<Lane> = []
    @ObservationIgnored private var pausedReads: Set<Lane> = []
    @ObservationIgnored private var dates: [Lane: Date] = [:]
    @ObservationIgnored private var revisions: [Lane: UUID] = [:]
    @ObservationIgnored private var tasks: [Lane: Task<Void, Never>] = [:]
    @ObservationIgnored private var onlineWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var statusFailed = false
    @ObservationIgnored private var desktopFailed = false
    private enum Lane: CaseIterable, Hashable { case status, models, research, providers, desktop }

    public init(service: any NativeSettingsAIService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
    }
    public var isLoadingStatus: Bool { ollamaStatus == nil && fetching.contains(.status) }
    public var isLoadingModels: Bool { ollamaModels == nil && fetching.contains(.models) }
    public var isLoadingResearch: Bool { researchStatus == nil && fetching.contains(.research) }
    public var isLoadingProviders: Bool { providerStatuses == nil && fetching.contains(.providers) }
    public var isFetchingDesktop: Bool { fetching.contains(.desktop) }
    public var isPendingDesktop: Bool { desktopStatus == nil && !desktopFailed }
    public var statusPollInterval: TimeInterval? {
        if ollamaStatus?.enabled == false { return nil }
        return statusFailed || ollamaStatus?.ok == false ? 120 : 30
    }
    public var statusLabelKey: String {
        isLoadingStatus
            ? "settings.aiChat.statusChecking"
            : ollamaStatus?.ok == true ? "settings.aiChat.statusReady" : "settings.aiChat.statusUnreachable"
    }
    public var modelPlaceholderKey: String {
        ollamaStatus?.ok != true
            ? "settings.aiChat.statusUnreachable"
            : isLoadingModels
                ? "settings.aiChat.loadingModels"
                : ollamaModels?.isEmpty == false ? "settings.aiChat.selectModel" : "settings.aiChat.noModels"
    }
    public var canSelectLocalModel: Bool {
        ollamaStatus?.ok == true && !isLoadingModels && ollamaModels?.isEmpty == false
    }
    public var selectedLocalModel: String { rawApp?["aiDefaultModel"]?.stringValue ?? ollamaStatus?.defaultModel ?? "" }
    public var openAiModels: [OpenAIResearchModel] { researchStatus?.openAiModels ?? [] }
    public var selectedOpenAiModel: String {
        let user = rawApp?["openAiDefaultModel"]?.stringValue
        let configured = openAiModels.contains { $0.id == user } ? user : researchStatus?.openAiModel
        return configured ?? openAiModels.first?.id ?? ""
    }
    public var canSelectOpenAiModel: Bool {
        !isLoadingResearch && researchStatus?.openAiEnabled == true && !openAiModels.isEmpty
    }
    public var openAiPlaceholderKey: String {
        isLoadingResearch
            ? "settings.aiOpenAi.loadingModels"
            : openAiModels.isEmpty ? "settings.aiOpenAi.noModels" : "settings.aiOpenAi.selectModel"
    }
    public var selectedAnswerDepth: String { rawApp?["aiAnswerDepth"]?.stringValue ?? "product-default" }
    public var desktopLabelKey: String {
        if isPendingDesktop { return "settings.agentCloak.checking" }
        guard let value = desktopStatus else { return "settings.agentCloak.statusError" }
        if value.enabled && value.available && value.mappingKeyConfigured { return "settings.agentCloak.active" }
        if value.enabled { return "settings.agentCloak.enabledUnavailable" }
        return value.available ? "settings.agentCloak.ready" : "settings.agentCloak.notDetected"
    }
    public var canToggleDesktop: Bool { !isTogglingDesktop && desktopStatus.map { $0.enabled || $0.available } == true }
    public var canCheckDesktop: Bool { !isFetchingDesktop && !isTogglingDesktop }
    public func configure(appRaw: TaxValue?) {
        rawApp = appRaw
        if !active { benchmarkDraft = appRaw?["analysisBenchmark"]?.stringValue ?? "" }
    }
    public func load() async {
        if active { return }
        active = true
        visit = UUID()
        benchmarkDraft = rawApp?["analysisBenchmark"]?.stringValue ?? ""
        benchmarkError = false
        await initialReads()
    }
    public func didDisappear() {
        active = false
        visit = UUID()
        for task in tasks.values { task.cancel() }
        tasks = [:]
        fetching = []
        pausedReads = []
        for lane in Lane.allCases { revisions[lane] = UUID() }
        keyInputs = [:]
        benchmarkDraft = ""
        benchmarkError = false
        isSavingKey = false
        isClearingKey = false
        isTogglingDesktop = false
        desktopMutationError = nil
    }
    private func initialReads() async {
        async let status: Void = read(.status)
        async let research: Void = read(.research)
        async let providers: Void = read(.providers)
        async let desktop: Void = read(.desktop)
        _ = await (status, research, providers, desktop)
        if ollamaStatus?.ok == true { await read(.models) }
    }
    private func reconnect() async {
        guard active else { return }
        // Paused queries need focus to continue; a new stale query can start online in background.
        if isForeground { await resumePausedReads() }
        let candidates = Lane.allCases.filter { !pausedReads.contains($0) }
        for lane in candidates where lane != .models || ollamaStatus?.ok == true { await read(lane) }
    }
    private func resumePausedReads() async {
        guard active, isOnline, isForeground else { return }
        let pending = pausedReads
        for lane in pending where lane != .models || ollamaStatus?.ok == true { await read(lane, force: true) }
    }
    public func pollStatus() async {
        guard active, isOnline, isForeground, statusPollInterval != nil else { return }
        await read(.status, force: true)
        if ollamaStatus?.ok == true { await read(.models) }
    }
    public func checkAgentCloak() async {
        guard active, canCheckDesktop else { return }
        desktopMutationError = nil
        await read(.desktop, force: true)
    }
    public func toggleAgentCloak() async {
        guard active, canToggleDesktop, let desktopStatus else { return }
        let scope = visit
        isTogglingDesktop = true
        desktopMutationError = nil
        retire(.desktop)
        retire(.research)
        await waitForOnline()
        do {
            let receipt = try await service.settingsAIConfigureDesktop(enabled: !desktopStatus.enabled)
            dates[.desktop] = nil
            dates[.research] = nil
            didInvalidateResearchStatus?()
            if active, visit == scope {
                self.desktopStatus = receipt
                desktopFailed = false
                isTogglingDesktop = false
                retire(.desktop)
                retire(.research)
                async let desktop: Void = read(.desktop, force: true)
                async let research: Void = read(.research, force: true)
                _ = await (desktop, research)
            }
        } catch {
            if active, visit == scope {
                isTogglingDesktop = false
                desktopMutationError = error.localizedDescription
            }
            dates[.desktop] = nil
            dates[.research] = nil
            retire(.desktop)
            retire(.research)
        }
    }
    public func keyInput(_ provider: String) -> String { keyInputs[provider] ?? "" }
    public func setKeyInput(_ provider: String, _ value: String) { keyInputs[provider] = value }
    public func canSaveKey(_ provider: String) -> Bool {
        !isSavingKey && !NativeSettingsAIText.trim(keyInput(provider)).isEmpty
    }
    public func canClearKey(_ provider: String) -> Bool {
        !isClearingKey && providerStatuses?.items.first { $0.provider == provider }?.source == "settings"
    }
    public func saveProviderKey(_ provider: String) async {
        guard active, canSaveKey(provider) else { return }
        let input = NativeSettingsAIText.trim(keyInput(provider))
        keyInputs[provider] = ""
        let scope = visit
        isSavingKey = true
        retire(.providers)
        await waitForOnline()
        do {
            _ = try await service.settingsAISetProviderKey(provider: provider, input: input)
            dates[.providers] = nil
            retire(.providers)
            didNotice?("settings.research.saved")
            if active, visit == scope { isSavingKey = false }
            if active { await read(.providers, force: true) }
        } catch {
            dates[.providers] = nil
            retire(.providers)
            if active, visit == scope { isSavingKey = false }
            didNotice?("settings.research.saveFailed")
        }
    }
    public func clearProviderKey(_ provider: String) async {
        guard active, canClearKey(provider) else { return }
        let scope = visit
        isClearingKey = true
        retire(.providers)
        await waitForOnline()
        do {
            try await service.settingsAIClearProviderKey(provider: provider)
            dates[.providers] = nil
            retire(.providers)
            didNotice?("settings.research.cleared")
            if active, visit == scope { isClearingKey = false }
            if active { await read(.providers, force: true) }
        } catch {
            dates[.providers] = nil
            retire(.providers)
            if active, visit == scope { isClearingKey = false }
            didNotice?("settings.research.clearFailed")
        }
    }
    public func commitBenchmark(_ edit: (TaxValue?) -> Void) {
        guard let value = NativeSettingsAIText.benchmark(benchmarkDraft) else {
            benchmarkError = true
            return
        }
        benchmarkError = false
        benchmarkDraft = value
        edit(value.isEmpty ? nil : .string(value))
    }
    public func clearBenchmark(_ edit: (TaxValue?) -> Void) {
        benchmarkDraft = ""
        benchmarkError = false
        edit(nil)
    }
    public func updateBenchmarkDraft(_ value: String) { benchmarkDraft = NativeSettingsAIText.limitBenchmark(value) }
    private func waitForOnline() async {
        guard !isOnline else { return }
        await withCheckedContinuation { onlineWaiters.append($0) }
    }
    private func retire(_ lane: Lane) {
        revisions[lane] = UUID()
        tasks[lane]?.cancel()
        tasks[lane] = nil
        fetching.remove(lane)
    }
    private func ttl(_ lane: Lane) -> TimeInterval { lane == .status ? 15 : lane == .desktop ? 30 : 60 }
    private func read(_ lane: Lane, force: Bool = false) async {
        guard active, !Task.isCancelled else { return }
        if let task = tasks[lane] {
            await task.value
            return
        }
        if !force, let date = dates[lane], now().timeIntervalSince(date) < ttl(lane) { return }
        guard isOnline else {
            pausedReads.insert(lane)
            return
        }
        pausedReads.remove(lane)
        let scope = visit
        let revision = UUID()
        revisions[lane] = revision
        fetching.insert(lane)
        if lane == .desktop {
            desktopReadError = nil
            if desktopStatus == nil { desktopFailed = false }
        }
        let task = Task { [weak self] in
            guard let self, active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
            do {
                try await performRead(lane, scope: scope, revision: revision)
            } catch {
                // Provider status inherits QueryClient retry: 1; the other source queries explicitly disable it.
                if lane == .providers, active, visit == scope, revisions[lane] == revision, !Task.isCancelled {
                    do { try await performRead(lane, scope: scope, revision: revision) } catch {}
                } else if active, visit == scope, revisions[lane] == revision {
                    if lane == .status { statusFailed = true }
                    if lane == .desktop {
                        desktopFailed = true
                        desktopReadError = error.localizedDescription
                    }
                }
            }
            guard active, visit == scope, revisions[lane] == revision else { return }
            fetching.remove(lane)
            tasks[lane] = nil
        }
        tasks[lane] = task
        await task.value
    }
    private func performRead(_ lane: Lane, scope: UUID, revision: UUID) async throws {
        switch lane {
        case .status:
            let value = try await service.settingsAIStatus()
            guard active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
            ollamaStatus = value
            statusFailed = false
        case .models:
            guard ollamaStatus?.ok == true else { return }
            let value = try await service.settingsAIModels()
            guard active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
            ollamaModels = value
        case .research:
            let value = try await service.settingsAIResearchStatus()
            guard active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
            researchStatus = value
        case .providers:
            let value = try await service.settingsAIProviderKeys()
            guard active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
            providerStatuses = value
        case .desktop:
            let value = try await service.settingsAIDesktopStatus()
            guard active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
            desktopStatus = value
            desktopFailed = false
            desktopReadError = nil
        }
        guard active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
        dates[lane] = now()
    }
}
