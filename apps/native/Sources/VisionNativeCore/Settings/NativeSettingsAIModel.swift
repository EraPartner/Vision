import Foundation
import Observation

@MainActor @Observable public final class NativeSettingsAIModel {
    public private(set) var ollamaStatus: AIChatOllamaStatus?
    public private(set) var ollamaModels: [AIChatOllamaModel]?
    public private(set) var providerStatuses: NativeSettingsAIProviderStatuses?
    /// `useModelFit` data for `fitModel`; shown only through `fitVariables`.
    public private(set) var modelFit: OpenAPI.AiModelFit?
    public private(set) var isSavingKey = false
    public private(set) var isClearingKey = false
    public private(set) var benchmarkError = false
    public var benchmarkDraft = ""
    public var isOnline = true {
        didSet {
            if isOnline && !oldValue {
                resumePausedMutations()
                if active { Task { [weak self] in await self?.reconnect() } }
            }
        }
    }
    public var isForeground = true {
        didSet {
            if isForeground && !oldValue {
                resumePausedMutations()
                if active && !pausedReads.isEmpty { Task { [weak self] in await self?.resumePausedReads() } }
            }
        }
    }
    public var didNotice: (@MainActor (String) -> Void)?
    public var didReceiveStatus: (@MainActor (NativeSettingsAIReceipt<AIChatOllamaStatus>) -> Void)?
    public var didReceiveModels: (@MainActor (NativeSettingsAIReceipt<[AIChatOllamaModel]>) -> Void)?
    public var didInvalidateSharedReads: (@MainActor ([String]) -> Void)?
    public var sharedStatusReceipt: NativeSettingsAIReceipt<AIChatOllamaStatus>? {
        guard let ollamaStatus, let date = dates[.status] else { return nil }
        return .init(value: ollamaStatus, fetchedAt: date)
    }
    public var sharedModelsReceipt: NativeSettingsAIReceipt<[AIChatOllamaModel]>? {
        guard let ollamaModels, let date = dates[.models] else { return nil }
        return .init(value: ollamaModels, fetchedAt: date)
    }
    public func seedSharedStatus(_ value: AIChatOllamaStatus, fetchedAt: Date) {
        guard dates[.status].map({ fetchedAt > $0 }) ?? true else { return }
        retire(.status)
        pausedReads.remove(.status)
        ollamaStatus = value
        dates[.status] = fetchedAt
        statusFailed = false
    }
    public func seedSharedModels(_ value: [AIChatOllamaModel], fetchedAt: Date) {
        guard dates[.models].map({ fetchedAt > $0 }) ?? true else { return }
        retire(.models)
        pausedReads.remove(.models)
        ollamaModels = value
        dates[.models] = fetchedAt
    }
    public func invalidateSharedAIReads(_ keys: [String]) {
        for (key, lane) in [("ollama-status", Lane.status), ("ollama-models", .models)] where keys.contains(key) {
            dates[lane] = nil
            retire(lane)
        }
    }
    @ObservationIgnored private let service: any NativeSettingsAIService
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
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
    @ObservationIgnored private var providerRetryPending = false
    @ObservationIgnored private var fitModel: String?
    @ObservationIgnored private var fitDate: Date?
    @ObservationIgnored private var fitRevision = UUID()
    @ObservationIgnored private var fitTask: Task<Void, Never>?
    @ObservationIgnored private var statusFailed = false
    private enum Lane: CaseIterable, Hashable { case status, models, providers }

    public init(
        service: any NativeSettingsAIService, now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.service = service
        self.now = now
        self.sleep = sleep
    }
    public var isLoadingStatus: Bool { ollamaStatus == nil && fetching.contains(.status) }
    public var isLoadingModels: Bool { ollamaModels == nil && fetching.contains(.models) }
    public var isLoadingProviders: Bool { providerStatuses == nil && fetching.contains(.providers) }
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
    public var selectedAnswerDepth: String { rawApp?["aiAnswerDepth"]?.stringValue ?? "product-default" }
    public func configure(appRaw: TaxValue?) {
        rawApp = appRaw
        if !active { benchmarkDraft = appRaw?["analysisBenchmark"]?.stringValue ?? "" }
        refreshFit()
    }
    /// The model whose memory advisor line applies: Ollama is reachable, a model is selected and it
    /// is not the Apple Foundation model (`useModelFit` is off for it).
    var fitTarget: String? {
        let model = selectedLocalModel
        return ollamaStatus?.ok == true && !model.isEmpty && model != appleFoundationModel ? model : nil
    }
    /// `AIChatSettingsSection` `fitLine`: the variables of `settings.aiChat.modelFit`, or nil when
    /// Ollama cannot say (any null field), the fit belongs to another model or is not applicable.
    public var fitVariables: [String: String]? {
        guard let target = fitTarget, fitModel == target, let fit = modelFit else { return nil }
        return Self.fitVariables(fit)
    }
    public static func fitVariables(_ fit: OpenAPI.AiModelFit) -> [String: String]? {
        guard let weights = fit.weightBytes, let perToken = fit.kvBytesPerToken, let window = fit.maxNumCtx else {
            return nil
        }
        let gib = Double(1 << 30)
        return [
            "weights": String(format: "%.1f", Double(weights) / gib),
            "context": String(format: "%.1f", Double(perToken * window) / gib),
            "total": String(Int((Double(fit.totalMemoryBytes) / gib).rounded())),
        ]
    }
    /// `useModelFit`: staleTime 60 s, no retry, keyed by model; a model change drops the shown data.
    func refreshFit() {
        guard active, isOnline, let target = fitTarget else { return }
        if fitModel != target {
            fitModel = target
            fitDate = nil
            modelFit = nil
            fitRevision = UUID()
            fitTask?.cancel()
            fitTask = nil
        }
        guard fitTask == nil, fitDate.map({ now().timeIntervalSince($0) >= 60 }) ?? true else { return }
        let revision = fitRevision
        let scope = visit
        fitTask = Task { [weak self] in
            guard let self else { return }
            let result = try? await service.settingsAIModelFit(model: target)
            guard active, visit == scope, fitRevision == revision, !Task.isCancelled else { return }
            fitTask = nil
            fitDate = now()
            if let result { modelFit = result }
        }
    }
    /// Waits for the model-fit read in flight, if any.
    public func settleFit() async { await fitTask?.value }
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
        fitTask?.cancel()
        fitTask = nil
        fitRevision = UUID()
        fetching = []
        pausedReads = []
        providerRetryPending = false
        for lane in Lane.allCases { revisions[lane] = UUID() }
        keyInputs = [:]
        benchmarkDraft = ""
        benchmarkError = false
        isSavingKey = false
        isClearingKey = false
    }
    private func initialReads() async {
        async let statusAndModels: Void = readStatusAndModels()
        async let providers: Void = read(.providers)
        _ = await (statusAndModels, providers)
    }
    private func readStatusAndModels() async {
        if ollamaStatus?.ok == true {
            async let models: Void = read(.models)
            await read(.status)
            await models
        } else {
            await read(.status)
            if ollamaStatus?.ok == true { await read(.models) }
        }
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
        for lane in pending where lane != .models || ollamaStatus?.ok == true {
            // A concurrent reconnect/focus continuation may have resumed this lane while we awaited another.
            guard pausedReads.contains(lane) else { continue }
            await read(lane, force: true)
        }
    }
    public func pollStatus() async {
        guard active, isOnline, isForeground, statusPollInterval != nil else { return }
        await read(.status, force: true)
        if ollamaStatus?.ok == true { await read(.models) }
    }
    public func keyInput(_ provider: String) -> String { keyInputs[provider] ?? "" }
    public func setKeyInput(_ provider: String, _ value: String) { keyInputs[provider] = value }
    public func canSaveKey(_ provider: String) -> Bool {
        !isSavingKey && !NativeSettingsAIText.trim(keyInput(provider)).isEmpty
    }
    public func canClearKey(_ provider: String) -> Bool {
        !isClearingKey && providerStatuses?.items.first { $0.provider == provider }?.source == .settings
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
            await service.settingsAIInvalidateReads(["provider-keys"])
            didInvalidateSharedReads?(["provider-keys"])
            didNotice?("settings.research.saved")
            if active, visit == scope { isSavingKey = false }
            if active { await read(.providers, force: true) }
        } catch {
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
            await service.settingsAIInvalidateReads(["provider-keys"])
            didInvalidateSharedReads?(["provider-keys"])
            didNotice?("settings.research.cleared")
            if active, visit == scope { isClearingKey = false }
            if active { await read(.providers, force: true) }
        } catch {
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
        // An online mutation can start in the background. Once paused offline, source retryer
        // continuation requires both online and focused, including after this pane unmounts.
        guard !isOnline else { return }
        await withCheckedContinuation { onlineWaiters.append($0) }
    }
    private func resumePausedMutations() {
        guard isOnline, isForeground else { return }
        let pending = onlineWaiters
        onlineWaiters = []
        for continuation in pending { continuation.resume() }
    }
    private func retire(_ lane: Lane) {
        if lane == .providers { providerRetryPending = false }
        revisions[lane] = UUID()
        tasks[lane]?.cancel()
        tasks[lane] = nil
        fetching.remove(lane)
    }
    private func ttl(_ lane: Lane) -> TimeInterval { lane == .status ? 15 : 60 }
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
        let continuingRetry = lane == .providers && providerRetryPending
        if lane == .providers { providerRetryPending = false }
        let revision = UUID()
        revisions[lane] = revision
        fetching.insert(lane)
        let task = Task { [weak self] in
            guard let self, active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
            do {
                try await performRead(lane, scope: scope, revision: revision)
            } catch {
                // Provider status inherits QueryClient retry: 1; the other source queries explicitly disable it.
                if lane == .providers, !continuingRetry, active, visit == scope, revisions[lane] == revision,
                    !Task.isCancelled
                {
                    do {
                        try await sleep(.seconds(1))
                        guard active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
                        if isOnline && isForeground {
                            try await performRead(lane, scope: scope, revision: revision)
                        } else {
                            pausedReads.insert(.providers)
                            providerRetryPending = true
                        }
                    } catch {}
                } else if active, visit == scope, revisions[lane] == revision {
                    if lane == .status { statusFailed = true }
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
        case .providers:
            let value = try await service.settingsAIProviderKeys()
            guard active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
            providerStatuses = value
        }
        guard active, visit == scope, revisions[lane] == revision, !Task.isCancelled else { return }
        dates[lane] = now()
        if lane == .status { refreshFit() }
        switch lane {
        case .status: if let receipt = sharedStatusReceipt { didReceiveStatus?(receipt) }
        case .models: if let receipt = sharedModelsReceipt { didReceiveModels?(receipt) }
        default: break
        }
    }
}
