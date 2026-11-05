import Foundation
import Observation

@MainActor @Observable public final class NativeOnboardingModel {
    public private(set) var draft = NativeOnboardingDraft()
    public private(set) var isLoading = false
    public private(set) var isPresented = false
    public private(set) var isCompleting = false
    public private(set) var adaptersLoading = false
    public private(set) var adapters: [ImportAdapter] = []
    public private(set) var file: ImportFile?
    public private(set) var importing = false
    public private(set) var creatingCategories = false
    public private(set) var notice: ScreenNotice?
    public var isOnline = true
    public var strings: any Localizing = DictionaryStrings(language: .en, table: [:])
    public let restore: NativeSettingsBackupModel
    public var didComplete: (@MainActor () -> Void)?
    public var navigate: (@MainActor (String) -> Void)?
    public var openSettings: (@MainActor (String) -> Void)?
    public var requestDashboardArrival: (@MainActor () -> Void)?
    public var didMutateCategories: (@MainActor () async -> Void)?
    public var didMutateImports: (@MainActor () async -> Void)?
    /// Acknowledges completion and clears v1 draft through fresh restored-database/storage authority.
    public var completeAfterRestore: (@MainActor () async throws -> Void)?
    @ObservationIgnored private let service: any NativeOnboardingService
    @ObservationIgnored private let desktop: any NativeSettingsDesktopService
    @ObservationIgnored private let persistence: NativeSettingsPersistence
    @ObservationIgnored private let store: any NativeOnboardingDraftStore
    @ObservationIgnored private var visit = UUID()
    public private(set) var isLoaded = false
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var loadTaskID: UUID?
    @ObservationIgnored private var draftWrite: Task<Void, Never>?
    @ObservationIgnored private var acceptedActions: Set<UUID> = []
    @ObservationIgnored private var acceptedActionWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var storageFailureShown = false
    @ObservationIgnored private var notices = NoticeCounter()

    public init(
        service: any NativeOnboardingService, persistence: NativeSettingsPersistence,
        store: any NativeOnboardingDraftStore, desktop: any NativeSettingsDesktopService
    ) {
        self.service = service
        self.desktop = desktop
        self.persistence = persistence
        self.store = store
        restore = NativeSettingsBackupModel(service: desktop)
        restore.didRestore = { [weak self] in await self?.completedRestore() }
    }
    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }
    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
    public func load(force: Bool = false) async {
        if let loadTask {
            await loadTask.value
            return
        }
        guard !isLoading, force || !isLoaded else { return }
        let id = UUID()
        loadTaskID = id
        let task = Task { [weak self] in
            guard let self else { return }
            await self.loadCompletion()
        }
        loadTask = task
        await task.value
        if loadTaskID == id {
            loadTask = nil
            loadTaskID = nil
        }
    }
    private func loadCompletion() async {
        guard !Task.isCancelled else { return }
        isLoading = true
        let scope = visit
        let completed: Bool
        do {
            completed = try await persistence.read(.onboardingComplete).value == .bool(true)
        } catch is CancellationError {
            if scope == visit { isLoading = false }
            return
        } catch { completed = false }
        guard scope == visit else { return }
        guard !Task.isCancelled else {
            stopCancelledOpening(scope)
            return
        }
        isLoading = false
        isLoaded = true
        if !completed { await begin() }
    }
    /// Called on every closed-to-open transition, including Settings restart.
    public func begin() async {
        guard !Task.isCancelled else { return }
        visit = UUID()
        let scope = visit
        isLoading = true
        await draftWrite?.value
        guard scope == visit else { return }
        guard !Task.isCancelled else {
            stopCancelledOpening(scope)
            return
        }
        let data: Data?
        do { data = try await store.read() } catch is CancellationError {
            stopCancelledOpening(scope)
            return
        } catch { data = nil }
        guard scope == visit else { return }
        guard !Task.isCancelled else {
            stopCancelledOpening(scope)
            return
        }
        draft = NativeOnboardingDraft.read(data)
        file = nil
        importing = false
        creatingCategories = false
        isCompleting = false
        isLoading = false
        isPresented = true
        restore.activateRestoreOnly()
        persistDraft()
        await loadAdapters()
    }
    private func stopCancelledOpening(_ scope: UUID) {
        guard scope == visit else { return }
        isLoading = false
        if !isPresented { isLoaded = false }
    }
    public func selectRestoreFile() async -> String? {
        let scope = visit
        do {
            let file = try await desktop.selectBackupFile()
            guard scope == visit, isPresented, let file, !file.isEmpty else { return nil }
            return file
        } catch {
            if scope == visit { show(.error, "settings.restore.failed", ["msg": error.localizedDescription]) }
            return nil
        }
    }
    public func loadAdapters() async {
        guard isPresented, isOnline, !adaptersLoading else { return }
        let scope = visit
        adaptersLoading = true
        defer { if scope == visit { adaptersLoading = false } }
        do {
            let result = try await service.onboardingAdapters()
            guard scope == visit, isPresented else { return }
            adapters = result
            if !draft.selectedBank.isEmpty, !result.contains(where: { $0.key == draft.selectedBank }) {
                draft.selectedBank = ""
                if draft.step == .importData, draft.importResult == nil, draft.reviewBatch == nil { draft.step = .bank }
                persistDraft()
            }
        } catch {
            // Source useAdapters shows its empty catalog on a failed read.
        }
    }
    public var stepIndex: Int { NativeOnboardingStep.allCases.firstIndex(of: draft.step) ?? 0 }
    public var canImport: Bool { file != nil && !draft.selectedBank.isEmpty && !importing && !isCompleting }
    public func next() { setStep(stepIndex + 1) }
    public func back() { setStep(stepIndex - 1) }
    private func setStep(_ index: Int) {
        guard isPresented, !isCompleting, NativeOnboardingStep.allCases.indices.contains(index) else { return }
        draft.step = NativeOnboardingStep.allCases[index]
        persistDraft()
    }
    public func selectBank(_ key: String) {
        guard isPresented, !isCompleting else { return }
        draft.selectedBank = key
        persistDraft()
    }
    public func setFile(_ value: ImportFile?) {
        guard isPresented, !isCompleting else { return }
        if let value, !value.isCSV { return }
        file = value
    }
    public func unreadableFile() {
        show(.error, "onboarding.toast.importFailed", ["msg": strings.t("apiError.unknown")])
    }
    public func toggleCategory(_ index: Int) {
        guard isPresented, !isCompleting, NativeOnboardingPreset.categories.indices.contains(index) else { return }
        if let existing = draft.selectedCategoryIndexes.firstIndex(of: index) {
            draft.selectedCategoryIndexes.remove(at: existing)
        } else {
            draft.selectedCategoryIndexes.append(index)
        }
        persistDraft()
    }
    public func toggleAllCategories() {
        guard isPresented, !isCompleting else { return }
        draft.selectedCategoryIndexes =
            draft.selectedCategoryIndexes.count == NativeOnboardingPreset.categories.count
            ? [] : Array(NativeOnboardingPreset.categories.indices)
        persistDraft()
    }
    public func createCategories() async {
        guard isPresented, !creatingCategories, !isCompleting, !draft.selectedCategoryIndexes.isEmpty else { return }
        creatingCategories = true
        let scope = visit
        let action = beginAcceptedAction()
        defer {
            if scope == visit { creatingCategories = false }
            finishAcceptedAction(action)
        }
        let selected = draft.selectedCategoryIndexes
        let service = service
        // Promise.allSettled: every independent request settles, including partial durable success.
        let results = await withTaskGroup(
            of: (ordinal: Int, error: APIError?, cancelled: Bool).self,
            returning: [(ordinal: Int, error: APIError?, cancelled: Bool)].self
        ) {
            group in
            for (ordinal, index) in selected.enumerated() {
                let category = NativeOnboardingPreset.categories[index]
                group.addTask {
                    do {
                        try await service.onboardingCreateCategory(category)
                        return (ordinal, nil, false)
                    } catch is CancellationError {
                        return (ordinal, nil, true)
                    } catch { return (ordinal, APIError.wrapping(error), false) }
                }
            }
            var results: [(ordinal: Int, error: APIError?, cancelled: Bool)] = []
            for await result in group { results.append(result) }
            return results.sorted { $0.ordinal < $1.ordinal }
        }
        if results.contains(where: { $0.error == nil && !$0.cancelled }) { await didMutateCategories?() }
        if let failure = results.compactMap(\.error).first {
            show(.error, "onboarding.toast.categoriesFailed", ["msg": APIErrorMessage.text(failure, strings: strings)])
        } else {
            // Retirement cancels outstanding requests without a backend failure or success receipt.
            guard !results.contains(where: { $0.cancelled }) else { return }
            show(.success, "onboarding.toast.categoriesCreated", ["n": String(results.count)])
            guard scope == visit, isPresented, !isCompleting else { return }
            draft.categoriesCreated = true
            persistDraft()
        }
    }
    public func importFile() async {
        guard isPresented, canImport, let file else { return }
        importing = true
        let scope = visit
        let bank = draft.selectedBank
        let action = beginAcceptedAction()
        defer {
            if scope == visit { importing = false }
            finishAcceptedAction(action)
        }
        do {
            let receipt = try await service.onboardingImport(file: file, bank: bank)
            await didMutateImports?()
            switch receipt.outcome {
            case .completed(let counts):
                show(.success, "onboarding.toast.imported", ["n": String(counts.imported)])
                guard scope == visit, isPresented, !isCompleting else { return }
                draft.importResult = .init(imported: counts.imported, duplicates: counts.duplicates)
            case .reviewRequired(let id):
                show(.info, "onboarding.toast.reviewRequired", ["n": String(receipt.reviewRows)])
                guard scope == visit, isPresented, !isCompleting else { return }
                draft.reviewBatch = .init(batchId: id, rows: receipt.reviewRows)
            }
            persistDraft()
        } catch {
            if !(error is CancellationError) {
                show(.error, "onboarding.toast.importFailed", ["msg": ImportErrorText.text(error, strings: strings)])
            }
        }
    }
    public func finish(path: String? = nil, settingsSection: String? = nil, dashboardArrival: Bool = false) async {
        guard isPresented, !isCompleting else { return }
        isCompleting = true
        let scope = visit
        let action = beginAcceptedAction()
        defer {
            if scope == visit { isCompleting = false }
            finishAcceptedAction(action)
        }
        await draftWrite?.value
        do {
            if await persistence.baseline(.onboardingComplete) == nil {
                _ = try await persistence.read(.onboardingComplete)
            }
            _ = try await persistence.save(.onboardingComplete, value: .bool(true))
            guard scope == visit, isPresented else { return }
            try? await store.remove()
            guard scope == visit else { return }
            isPresented = false
            visit = UUID()
            isCompleting = false
            restore.didDisappear()
            didComplete?()
            if dashboardArrival { requestDashboardArrival?() }
            if let path { navigate?(path) }
            if let settingsSection { openSettings?(settingsSection) }
        } catch { if scope == visit { show(.error, "onboarding.persist.failed") } }
    }
    public func finishFinalStep() async {
        if let review = draft.reviewBatch {
            await finish(path: ImportRoutes.reviewPath(review.batchId))
        } else {
            await finish(path: "/", dashboardArrival: true)
        }
    }
    private func completedRestore() async {
        let scope = visit
        guard isPresented else { return }
        do {
            guard let completeAfterRestore else { throw APIError.backendUnavailable }
            try await completeAfterRestore()
            guard scope == visit else { return }
            isPresented = false
            visit = UUID()
            didComplete?()
        } catch { if scope == visit { show(.error, "onboarding.persist.failed") } }
    }
    /// Ordinary reload waits accepted ACK/callback/draft tails while their writers are still open.
    /// A database restore uses retirement instead and must not wait here after pausing writers.
    public func flushAcceptedActions() async {
        while !acceptedActions.isEmpty {
            await withCheckedContinuation { acceptedActionWaiters.append($0) }
        }
        await draftWrite?.value
    }
    private func beginAcceptedAction() -> UUID {
        let id = UUID()
        acceptedActions.insert(id)
        return id
    }
    private func finishAcceptedAction(_ id: UUID) {
        acceptedActions.remove(id)
        guard acceptedActions.isEmpty else { return }
        let waiters = acceptedActionWaiters
        acceptedActionWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }
    public func flushDraft() async { await draftWrite?.value }
    public func didDisappear() {
        loadTask?.cancel()
        loadTask = nil
        loadTaskID = nil
        visit = UUID()
        isPresented = false
        isLoading = false
        adaptersLoading = false
        file = nil
        restore.didDisappear()
    }
    private func persistDraft() {
        guard isPresented, !isCompleting else { return }
        let previous = draftWrite
        let scope = visit
        let value = draft
        draftWrite = Task { [weak self, store] in
            await previous?.value
            do {
                try await store.write(value.encoded())
                if let self, scope == self.visit { self.storageFailureShown = false }
            } catch is CancellationError {
                // A retired local generation deliberately discards its pending draft write.
                return
            } catch {
                guard let self, scope == self.visit, !self.storageFailureShown else { return }
                self.storageFailureShown = true
                self.show(.error, "onboarding.draftStorageFailed")
            }
        }
    }
    private func show(_ kind: ScreenNotice.Kind, _ key: String, _ variables: [String: String] = [:]) {
        notice = notices.make(kind, key, variables)
    }
}
