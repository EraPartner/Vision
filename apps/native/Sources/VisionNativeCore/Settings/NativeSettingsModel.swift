import Foundation
import Observation

/// Instant-apply settings live for the application lifetime. Closing the sheet does not cancel persistence.
@MainActor @Observable
public final class NativeSettingsModel {
    public private(set) var appRaw: TaxValue?
    public private(set) var dashboardRaw: TaxValue?
    public private(set) var themeRaw: TaxValue?
    public private(set) var isLoading = false
    public private(set) var isLoaded = false
    public private(set) var isSuspendedForRestore = false
    public var isOnline = true
    public private(set) var loadError: String?
    public private(set) var saveError: String?
    public private(set) var saveErrorNonce = 0
    public private(set) var categories: [OpenAPI.CategoryNode] = []
    public private(set) var recipients: [OpenAPI.Recipient] = []
    public private(set) var categoriesLoading = false
    public private(set) var recipientsLoading = false
    public private(set) var categoriesError: String?
    public private(set) var recipientsError: String?
    public var optionsLoading: Bool { categoriesLoading || recipientsLoading }
    public var optionsError: String? { categoriesError ?? recipientsError }
    public private(set) var includeTransfers = false
    public private(set) var cashRaw: TaxValue?
    public private(set) var cashLoading = false
    public private(set) var cashSaving = false
    public private(set) var keepServicesOnQuit = false
    public private(set) var servicesLoading = false
    public private(set) var servicesSaving = false
    public private(set) var notice: ScreenNotice?
    public var isLargeDisplay = false
    public private(set) var sessionTierOverride: VisualEffects?
    public var didNotice: (@MainActor (ScreenNotice) -> Void)?
    public var didChangeApp: (@MainActor (TaxValue) -> Void)?
    public var didChangeDashboard: (@MainActor (TaxValue) -> Void)?
    public var didChangeTheme: (@MainActor (TaxValue) -> Void)?
    public var didAcknowledge: (@MainActor (SettingKey, TaxValue) -> Void)?
    public var didChangeCostBasis: (@MainActor () async -> Void)?
    public var didChangeIncludeTransfers: (@MainActor () async -> Void)?
    public var didResetPreferences: (@MainActor () async -> Void)?
    public var clearRecurringLocalState: (@MainActor () async -> Void)?
    public var loadKeepServices: (@MainActor () async throws -> Bool)?
    public var saveKeepServices: (@MainActor (Bool) async throws -> Void)?
    public var legacyTheme: TaxValue?
    @ObservationIgnored private let service: any NativeSettingsService
    @ObservationIgnored public let persistence: NativeSettingsPersistence
    @ObservationIgnored private let delay: Duration
    @ObservationIgnored private let now: @MainActor () -> Date
    @ObservationIgnored private var categoriesFetchedAt: Date?
    @ObservationIgnored private var recipientsFetchedAt: Date?
    @ObservationIgnored private var timers: [SettingKey: Task<Void, Never>] = [:]
    @ObservationIgnored private var pendingDrafts: [SettingKey: TaxValue] = [:]
    @ObservationIgnored private var acceptedWrites: [UUID: Task<NativeSettingsRecord, Error>] = [:]
    @ObservationIgnored private var restoreDrain: Task<Void, Never>?
    @ObservationIgnored private var restoreResume: Task<Void, Never>?
    @ObservationIgnored private var retired = false
    @ObservationIgnored private var lifecycleRevision = 0
    @ObservationIgnored private var writes: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var editRevision: [SettingKey: Int] = [:]
    private var pendingWrites = 0
    private var pendingDebounces = 0
    @ObservationIgnored private var loadingRevision = 0
    @ObservationIgnored private var noticeRevision = 0
    @ObservationIgnored private var cashAcknowledged: TaxValue?
    public var isSaving: Bool { pendingWrites > 0 || pendingDebounces > 0 }
    public init(
        service: any NativeSettingsService, debounce: Duration = .milliseconds(500),
        now: @escaping @MainActor () -> Date = { Date() }
    ) {
        self.service = service
        persistence = .init(service: service)
        delay = debounce
        self.now = now
    }
    public convenience init(client: APIClient) { self.init(service: client) }
    public func appValue(_ key: String) -> TaxValue? { appRaw?[key] }
    public func appString(_ key: String, fallback: String) -> String {
        NativeSettingsDefaults.appValue(key, raw: appRaw)?.stringValue ?? fallback
    }
    public func appBool(_ key: String, fallback: Bool) -> Bool {
        NativeSettingsDefaults.appValue(key, raw: appRaw)?.boolValue ?? fallback
    }
    public func appInt(_ key: String, fallback: Int) -> Int {
        NativeSettingsDefaults.integer(NativeSettingsDefaults.appValue(key, raw: appRaw)) ?? fallback
    }
    public var costBasisMethod: CostBasisMethod {
        CostBasisMethod(rawValue: appString("costBasisMethod", fallback: CostBasisMethod.weightedAvg.rawValue))
    }
    public var startupSection: StartupSection {
        StartupSection(rawValue: appString("startupSection", fallback: StartupSection.budgeting.rawValue))
    }
    public func dashboardString(_ key: String, fallback: String) -> String {
        let raw = dashboardRaw?[key]?.stringValue
        if key == "exclusionScope", let raw, !["everywhere", "dashboard", "statistics"].contains(raw) {
            return fallback
        }
        return raw ?? fallback
    }
    public func dashboardBool(_ key: String, fallback: Bool) -> Bool { dashboardRaw?[key]?.boolValue ?? fallback }
    public func themeString(_ key: String, fallback: String) -> String {
        let raw = themeRaw?[key]?.stringValue
        let options =
            key == "mode"
            ? ["light", "dark", "system", "schedule"] : ["default", "dracula", "solarized", "nord", "high-contrast"]
        return raw.map { options.contains($0) ? $0 : fallback } ?? fallback
    }
    public func themeBool(_ key: String, fallback: Bool) -> Bool { themeRaw?[key]?.boolValue ?? fallback }
    public func themeScheduleString(_ key: String, fallback: String) -> String {
        themeRaw?["schedule"]?[key]?.stringValue ?? fallback
    }
    /// `defaultCurrency` of the stored (validated) `app_settings`, upper-cased as a typed code; `EUR`
    /// when it is not stored.
    public var defaultCurrencyCode: CurrencyCode {
        CurrencyCode(rawValue: appString("defaultCurrency", fallback: "EUR").uppercased()) ?? .eur
    }
    public var excludedCategoryIds: [CategoryID] {
        ids(dashboardRaw?["excludedCategoryIds"]).map(CategoryID.init(rawValue:))
    }
    public var excludedRecipientIds: [RecipientID] {
        ids(dashboardRaw?["excludedRecipientIds"]).map(RecipientID.init(rawValue:))
    }
    public var cashCategoryIds: [String: CategoryID] {
        Dictionary(
            uniqueKeysWithValues: ["dividend", "interest", "fee", "tax"].compactMap { key in
                cashCategoryId(key).map { (key, $0) }
            })
    }
    public func cashCategoryId(_ key: String) -> CategoryID? {
        NativeSettingsDefaults.integer(cashRaw?[key]).map(CategoryID.init(rawValue:))
    }
    public var supportsServices: Bool { loadKeepServices != nil && saveKeepServices != nil }
    /// The stored `visualEffects` tier (a value outside the web app's union reads as `standard`).
    public var visualEffects: VisualEffects {
        VisualEffects(rawValue: appString("visualEffects", fallback: VisualEffects.standard.rawValue))
    }
    public var effectiveVisualEffects: VisualEffects {
        appBool("autoAdaptDisplay", fallback: true) && isLargeDisplay ? sessionTierOverride ?? .reduced : visualEffects
    }
    public func selectVisualEffects(_ tier: VisualEffects) {
        guard !retired, !isSuspendedForRestore else { return }
        guard VisualEffects.allCases.contains(tier) else { return }
        if appBool("autoAdaptDisplay", fallback: true) && isLargeDisplay {
            sessionTierOverride = tier == .reduced ? nil : tier
        } else {
            updateApp(["visualEffects": .string(tier.rawValue)])
            sessionTierOverride = nil
        }
    }
    /// `AppSettings.fullEffects` (ADR-244, `useFullEffects`): restores the effects that were turned
    /// down to save GPU work. Off until the stored value says otherwise; the design layer reads this.
    public var fullEffects: Bool { appBool("fullEffects", fallback: false) }
    public func setFullEffects(_ enabled: Bool) {
        guard !retired, !isSuspendedForRestore else { return }
        updateApp(["fullEffects": .bool(enabled)])
    }
    public func setAutoAdaptDisplay(_ enabled: Bool) {
        guard !retired, !isSuspendedForRestore else { return }
        updateApp(["autoAdaptDisplay": .bool(enabled)])
        sessionTierOverride = nil
    }
    public func setAppValue(_ key: String, _ value: TaxValue?) {
        guard !retired, !isSuspendedForRestore else { return }
        var next = object(appRaw)
        next[key] = value.flatMap { NativeSettingsDefaults.appValue(key, raw: .object([key: $0])) }
        appRaw = .object(next)
        changed(.appSettings, appRaw!)
        didChangeApp?(appRaw!)
    }
    public func updateApp(_ fields: [String: TaxValue]) {
        guard !retired, !isSuspendedForRestore else { return }
        var next = object(appRaw)
        for (key, value) in fields {
            next[key] = value == .null ? nil : NativeSettingsDefaults.appValue(key, raw: .object([key: value]))
        }
        appRaw = .object(next)
        changed(.appSettings, appRaw!)
        didChangeApp?(appRaw!)
    }
    public func updateDashboard(_ fields: [String: TaxValue]) {
        guard !retired, !isSuspendedForRestore else { return }
        var next = object(dashboardRaw)
        next.merge(fields) { _, new in new }
        dashboardRaw = .object(next)
        changed(.dashboardSettings, dashboardRaw!)
        didChangeDashboard?(dashboardRaw!)
    }
    public func setExcludedCategoryIds(_ ids: [CategoryID]) {
        updateDashboard(["excludedCategoryIds": .array(ids.map { .number(Decimal($0.rawValue)) })])
    }
    public func setExcludedRecipientIds(_ ids: [RecipientID]) {
        updateDashboard(["excludedRecipientIds": .array(ids.map { .number(Decimal($0.rawValue)) })])
    }
    public func updateTheme(_ fields: [String: TaxValue]) {
        guard !retired, !isSuspendedForRestore else { return }
        var next = object(themeRaw)
        next.merge(fields) { _, new in new }
        // ThemeHydration persists these four fields, unlike the loose app/dashboard envelopes.
        themeRaw = .object(next)
        let known: TaxValue = .object([
            "mode": .string(themeString("mode", fallback: "dark")),
            "schedule": next["schedule"] ?? NativeSettingsDefaults.theme["schedule"]!,
            "variant": .string(themeString("variant", fallback: "default")),
            "systemAccent": .bool(themeBool("systemAccent", fallback: false)),
        ])
        changed(.themeSettings, known)
        didChangeTheme?(known)
    }
    public func updateThemeSchedule(_ fields: [String: TaxValue]) {
        var schedule = object(themeRaw?["schedule"] ?? NativeSettingsDefaults.theme["schedule"])
        schedule.merge(fields) { _, new in new }
        updateTheme(["schedule": .object(schedule)])
    }
    public func load(force: Bool = false) async {
        guard !retired, !isSuspendedForRestore, isOnline, !isLoading, force || !isLoaded else { return }
        loadingRevision += 1
        let token = loadingRevision
        let edits = editRevision
        isLoading = true
        cashLoading = !isLoaded
        loadError = nil
        defer {
            if loadingRevision == token {
                isLoading = false
                cashLoading = false
            }
        }
        do {
            let snapshot = try await persistence.readAll()
            guard token == loadingRevision else { return }
            if editRevision[.appSettings] == edits[.appSettings] && (editRevision[.appSettings] ?? 0) == 0 {
                appRaw = NativeSettingsDefaults.migrateApp(snapshot.settings[SettingKey.appSettings.rawValue])
                didChangeApp?(appRaw ?? .object([:]))
            }
            if editRevision[.dashboardSettings] == edits[.dashboardSettings]
                && (editRevision[.dashboardSettings] ?? 0) == 0
            {
                dashboardRaw = NativeSettingsDefaults.migrateDashboard(snapshot.settings[SettingKey.dashboardSettings.rawValue])
                didChangeDashboard?(dashboardRaw ?? .object([:]))
            }
            if editRevision[.themeSettings] == edits[.themeSettings] && (editRevision[.themeSettings] ?? 0) == 0 {
                let stored = snapshot.settings[SettingKey.themeSettings.rawValue]
                themeRaw = Self.isTruthy(stored) ? stored : legacyTheme
                didChangeTheme?(themeRaw ?? NativeSettingsDefaults.theme)
            }
            if (editRevision[.includeTransfers] ?? 0) == 0 {
                includeTransfers = snapshot.settings[SettingKey.includeTransfers.rawValue] == .bool(true)
            }
            if !cashSaving && editRevision[.brokerageCashCategoryIds] == edits[.brokerageCashCategoryIds] {
                cashRaw = snapshot.settings[SettingKey.brokerageCashCategoryIds.rawValue]
                cashAcknowledged = cashRaw
            }
            isLoaded = true
        } catch { if token == loadingRevision { loadError = "settings.saveFailed" } }
    }
    /// These reads belong to their active sections, not global settings hydration.
    public func loadOptions(force: Bool = false) async {
        async let categories: Void = loadCategories(force: force)
        async let recipients: Void = loadRecipients(force: force)
        _ = await (categories, recipients)
    }
    public func loadCategories(force: Bool = false) async {
        guard !retired, !isSuspendedForRestore, isOnline, !categoriesLoading,
            force || categoriesFetchedAt.map({ now().timeIntervalSince($0) >= 60 }) != false
        else { return }
        let lifecycle = lifecycleRevision
        categoriesLoading = true
        categoriesError = nil
        defer { categoriesLoading = false }
        do {
            let result = try await service.nativeSettingsCategories()
            guard lifecycle == lifecycleRevision, !retired else { return }
            categories = result
            categoriesFetchedAt = now()
        } catch { if lifecycle == lifecycleRevision, !retired { categoriesError = "settings.saveFailed" } }
    }
    public func loadRecipients(force: Bool = false) async {
        guard !retired, !isSuspendedForRestore, isOnline, !recipientsLoading,
            force || recipientsFetchedAt.map({ now().timeIntervalSince($0) >= 60 }) != false
        else { return }
        let lifecycle = lifecycleRevision
        recipientsLoading = true
        recipientsError = nil
        defer { recipientsLoading = false }
        do {
            let result = try await service.nativeSettingsRecipients()
            guard lifecycle == lifecycleRevision, !retired else { return }
            recipients = result
            recipientsFetchedAt = now()
        } catch { if lifecycle == lifecycleRevision, !retired { recipientsError = "settings.saveFailed" } }
    }
    public func setIncludeTransfers(_ value: Bool) async {
        guard !retired, !isSuspendedForRestore else { return }
        includeTransfers = value
        editRevision[.includeTransfers, default: 0] += 1
        do {
            _ = try await saveNow(.includeTransfers, value: .bool(value))
            await didChangeIncludeTransfers?()
        } catch {
            // The source optimistically keeps the toggle and intentionally ignores this failure.
        }
    }
    public func setCashCategory(_ kind: String, _ id: CategoryID?) async {
        guard !retired, !isSuspendedForRestore else { return }
        guard ["dividend", "interest", "fee", "tax"].contains(kind), !cashLoading, !cashSaving else { return }
        var next = object(cashRaw)
        for key in ["dividend", "interest", "fee", "tax"] where next[key] == nil { next[key] = .null }
        next[kind] = id.map { .number(Decimal($0.rawValue)) } ?? .null
        cashRaw = .object(next)
        editRevision[.brokerageCashCategoryIds, default: 0] += 1
        cashSaving = true
        defer { cashSaving = false }
        do {
            let result = try await saveNow(.brokerageCashCategoryIds, value: cashRaw!)
            cashRaw = result.value
            cashAcknowledged = result.value
        } catch {
            cashRaw = cashAcknowledged
            show(.error, "settings.saveFailed")
        }
    }
    public func setCostBasisMethod(_ method: CostBasisMethod) async {
        guard !retired, !isSuspendedForRestore else { return }
        guard CostBasisMethod.allCases.contains(method) else { return }
        updateApp(["costBasisMethod": .string(method.rawValue)])
        do {
            _ = try await saveNow(.costBasisMethod, value: .string(method.rawValue))
            await didChangeCostBasis?()
        } catch { show(.error, "settings.saveFailed") }
    }
    public func resetRecurringDismissals() async {
        guard !retired, !isSuspendedForRestore else { return }
        await clearRecurringLocalState?()
        do {
            _ = try await saveNow(.dismissedRecurringPatterns, value: .array([]))
            show(.success, "settings.app.recurringDismissalsResetSuccess")
        } catch { show(.error, "settings.app.recurringDismissalsResetFailed") }
    }
    public func resetPreferences() async {
        guard !retired, !isSuspendedForRestore else { return }
        appRaw = NativeSettingsDefaults.app
        dashboardRaw = NativeSettingsDefaults.dashboard
        sessionTierOverride = nil
        changed(.appSettings, appRaw!)
        changed(.dashboardSettings, dashboardRaw!)
        didChangeApp?(appRaw!)
        didChangeDashboard?(dashboardRaw!)
        includeTransfers = false
        editRevision[.includeTransfers, default: 0] += 1
        show(.info, "settings.resetToDefaults")
        do {
            _ = try await saveNow(.includeTransfers, value: .bool(false))
            await didResetPreferences?()
        } catch {
            // Source reset's server-only write is deliberately non-fatal.
        }
    }
    public func loadServices() async {
        guard !retired, !isSuspendedForRestore, let loadKeepServices, !servicesLoading else { return }
        let lifecycle = lifecycleRevision
        servicesLoading = true
        defer { servicesLoading = false }
        do {
            let value = try await loadKeepServices()
            guard lifecycle == lifecycleRevision, !retired else { return }
            keepServicesOnQuit = value
        } catch {
            // Display default; host writer refuses unknown baseline.
        }
    }
    public func setKeepServicesOnQuit(_ value: Bool) async {
        guard !retired, !isSuspendedForRestore else { return }
        guard let saveKeepServices, !servicesSaving else { return }
        keepServicesOnQuit = value
        servicesSaving = true
        defer { servicesSaving = false }
        do { try await saveKeepServices(value) } catch {
            keepServicesOnQuit = !value
            show(.error, "settings.saveFailed")
        }
    }
    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
    /// Useful at orderly shutdown and in integration tests; it never retries a rejected settings queue.
    public func flush() async {
        let currentTimers = Array(timers.values)
        for timer in currentTimers { await timer.value }
        for task in Array(writes.values) { await task.value }
    }
    /// Restore alone pauses application-lifetime preference saves. Ordinary sheet dismissal never calls this.
    public func suspendForRestore() async {
        if let restoreDrain {
            await restoreDrain.value
            return
        }
        guard !retired else { return }
        isSuspendedForRestore = true
        lifecycleRevision += 1
        loadingRevision += 1
        isLoading = false
        cashLoading = false
        for timer in timers.values { timer.cancel() }
        timers.removeAll()
        pendingDebounces = 0
        let accepted = Array(acceptedWrites.values)
        let writer = persistence
        let drain = Task {
            // Main-accepted writes reach their writer before its admission gate closes.
            for task in accepted { _ = try? await task.value }
            await writer.suspendForRestore()
        }
        restoreDrain = drain
        await drain.value
        for task in Array(writes.values) { await task.value }
    }
    /// Failed/cancelled restore resumes precisely the same opaque baselines and poisoned queues.
    public func resumeAfterFailedRestore() {
        guard !retired, isSuspendedForRestore else { return }
        isSuspendedForRestore = false
        restoreDrain = nil
        let writer = persistence
        let resumed = Task { await writer.resumeAfterFailedRestore() }
        restoreResume = resumed
        for (key, value) in pendingDrafts { schedule(key, value: value, revision: editRevision[key] ?? 0) }
    }
    /// Successful database replacement retires this generation. The SDK creates a fresh model/writer on reload.
    public func retireForReload() {
        guard !retired else { return }
        retired = true
        isSuspendedForRestore = true
        lifecycleRevision += 1
        loadingRevision += 1
        isLoading = false
        cashLoading = false
        for timer in timers.values { timer.cancel() }
        timers.removeAll()
        pendingDrafts.removeAll()
        pendingDebounces = 0
        didNotice = nil
        didChangeApp = nil
        didChangeDashboard = nil
        didChangeTheme = nil
        didAcknowledge = nil
        didChangeCostBasis = nil
        didChangeIncludeTransfers = nil
        didResetPreferences = nil
        clearRecurringLocalState = nil
        loadKeepServices = nil
        saveKeepServices = nil
        let writer = persistence
        Task { await writer.retireForReload() }
    }
    private func changed(_ key: SettingKey, _ value: TaxValue) {
        guard !retired else { return }
        let revision = editRevision[key, default: 0] + 1
        editRevision[key] = revision
        pendingDrafts[key] = value
        if !isSuspendedForRestore { schedule(key, value: value, revision: revision) }
    }
    private func schedule(_ key: SettingKey, value: TaxValue, revision: Int) {
        timers[key]?.cancel()
        timers[key] = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(for: delay) } catch { return }
            guard !self.retired, !self.isSuspendedForRestore, self.editRevision[key] == revision else { return }
            self.timers[key] = nil
            self.pendingDebounces = self.timers.count
            let id = UUID()
            let task = Task { [weak self] in
                guard let self else { return }
                defer { self.writes[id] = nil }
                guard !self.retired, !self.isSuspendedForRestore else { return }
                do { _ = try await self.saveNow(key, value: value, draftRevision: revision) } catch {
                    if !self.retired, key != .themeSettings {
                        self.saveError = "settings.saveFailed"
                        self.saveErrorNonce += 1
                        self.show(.error, "settings.saveFailed")
                    }
                }
            }
            self.writes[id] = task
        }
        pendingDebounces = timers.count
    }
    private func saveNow(_ key: SettingKey, value: TaxValue, draftRevision: Int? = nil) async throws -> NativeSettingsRecord
    {
        await restoreResume?.value
        guard !retired, !isSuspendedForRestore else { throw CancellationError() }
        if let draftRevision, editRevision[key] == draftRevision { pendingDrafts[key] = nil }
        pendingWrites += 1
        let id = UUID()
        let writer = persistence
        let task = Task { try await writer.save(key, value: value) }
        acceptedWrites[id] = task
        defer {
            pendingWrites -= 1
            acceptedWrites[id] = nil
        }
        let result = try await task.value
        guard !retired else { throw CancellationError() }
        didAcknowledge?(key, result.value)
        return result
    }
    private static func isTruthy(_ value: TaxValue?) -> Bool {
        switch value {
        case nil, .null: return false
        case .bool(let value): return value
        case .string(let value): return !value.isEmpty
        case .number(let value): return value != 0 && !value.isNaN
        case .array, .object: return true
        }
    }
    private func object(_ value: TaxValue?) -> [String: TaxValue] { value?.objectValue ?? [:] }
    private func ids(_ value: TaxValue?) -> [Int] {
        guard let rows = value?.arrayValue, rows.allSatisfy({ $0.decimalValue != nil }) else { return [] }
        return rows.compactMap(NativeSettingsDefaults.integer)
    }
    private func show(_ kind: ScreenNotice.Kind, _ key: String) {
        guard !retired else { return }
        noticeRevision += 1
        notice = .init(id: noticeRevision, kind: kind, key: key)
        didNotice?(notice!)
    }
}
