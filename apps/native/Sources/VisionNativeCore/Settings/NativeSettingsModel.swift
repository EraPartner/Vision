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
    public private(set) var sessionTierOverride: String?
    public var didNotice: (@MainActor (ScreenNotice) -> Void)?
    public var didChangeApp: (@MainActor (TaxValue) -> Void)?
    public var didChangeDashboard: (@MainActor (TaxValue) -> Void)?
    public var didChangeTheme: (@MainActor (TaxValue) -> Void)?
    public var didAcknowledge: (@MainActor (String, TaxValue) -> Void)?
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
    @ObservationIgnored private var timers: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var writes: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var editRevision: [String: Int] = [:]
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
    public var excludedCategoryIds: [Int] { ids(dashboardRaw?["excludedCategoryIds"]) }
    public var excludedRecipientIds: [Int] { ids(dashboardRaw?["excludedRecipientIds"]) }
    public var cashCategoryIds: [String: Int] {
        Dictionary(
            uniqueKeysWithValues: ["dividend", "interest", "fee", "tax"].compactMap { key in
                cashCategoryId(key).map { (key, $0) }
            })
    }
    public func cashCategoryId(_ key: String) -> Int? { NativeSettingsDefaults.integer(cashRaw?[key]) }
    public var supportsServices: Bool { loadKeepServices != nil && saveKeepServices != nil }
    public var effectiveVisualEffects: String {
        appBool("autoAdaptDisplay", fallback: true) && isLargeDisplay
            ? sessionTierOverride ?? "reduced" : appString("visualEffects", fallback: "standard")
    }
    public func selectVisualEffects(_ tier: String) {
        guard ["reduced", "standard", "enhanced"].contains(tier) else { return }
        if appBool("autoAdaptDisplay", fallback: true) && isLargeDisplay {
            sessionTierOverride = tier == "reduced" ? nil : tier
        } else {
            updateApp(["visualEffects": .string(tier)])
            sessionTierOverride = nil
        }
    }
    public func setAutoAdaptDisplay(_ enabled: Bool) {
        updateApp(["autoAdaptDisplay": .bool(enabled)])
        sessionTierOverride = nil
    }
    public func setAppValue(_ key: String, _ value: TaxValue?) {
        var next = object(appRaw)
        next[key] = value.flatMap { NativeSettingsDefaults.appValue(key, raw: .object([key: $0])) }
        appRaw = .object(next)
        changed("app_settings", appRaw!)
        didChangeApp?(appRaw!)
    }
    public func updateApp(_ fields: [String: TaxValue]) {
        var next = object(appRaw)
        for (key, value) in fields {
            next[key] = value == .null ? nil : NativeSettingsDefaults.appValue(key, raw: .object([key: value]))
        }
        appRaw = .object(next)
        changed("app_settings", appRaw!)
        didChangeApp?(appRaw!)
    }
    public func updateDashboard(_ fields: [String: TaxValue]) {
        var next = object(dashboardRaw)
        next.merge(fields) { _, new in new }
        dashboardRaw = .object(next)
        changed("dashboard_settings", dashboardRaw!)
        didChangeDashboard?(dashboardRaw!)
    }
    public func setExcludedCategoryIds(_ ids: [Int]) {
        updateDashboard(["excludedCategoryIds": .array(ids.map { .number(Decimal($0)) })])
    }
    public func setExcludedRecipientIds(_ ids: [Int]) {
        updateDashboard(["excludedRecipientIds": .array(ids.map { .number(Decimal($0)) })])
    }
    public func updateTheme(_ fields: [String: TaxValue]) {
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
        changed("theme_settings", known)
        didChangeTheme?(known)
    }
    public func updateThemeSchedule(_ fields: [String: TaxValue]) {
        var schedule = object(themeRaw?["schedule"] ?? NativeSettingsDefaults.theme["schedule"])
        schedule.merge(fields) { _, new in new }
        updateTheme(["schedule": .object(schedule)])
    }
    public func load(force: Bool = false) async {
        guard isOnline, !isLoading, force || !isLoaded else { return }
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
            if editRevision["app_settings"] == edits["app_settings"] && (editRevision["app_settings"] ?? 0) == 0 {
                appRaw = NativeSettingsDefaults.migrateApp(snapshot.settings["app_settings"])
                didChangeApp?(appRaw ?? .object([:]))
            }
            if editRevision["dashboard_settings"] == edits["dashboard_settings"]
                && (editRevision["dashboard_settings"] ?? 0) == 0
            {
                dashboardRaw = NativeSettingsDefaults.migrateDashboard(snapshot.settings["dashboard_settings"])
                didChangeDashboard?(dashboardRaw ?? .object([:]))
            }
            if editRevision["theme_settings"] == edits["theme_settings"] && (editRevision["theme_settings"] ?? 0) == 0 {
                let stored = snapshot.settings["theme_settings"]
                themeRaw = Self.isTruthy(stored) ? stored : legacyTheme
                didChangeTheme?(themeRaw ?? NativeSettingsDefaults.theme)
            }
            if (editRevision["includeTransfers"] ?? 0) == 0 {
                includeTransfers = snapshot.settings["includeTransfers"] == .bool(true)
            }
            if !cashSaving && editRevision["brokerage_cash_category_ids"] == edits["brokerage_cash_category_ids"] {
                cashRaw = snapshot.settings["brokerage_cash_category_ids"]
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
        guard isOnline, !categoriesLoading,
            force || categoriesFetchedAt.map({ now().timeIntervalSince($0) >= 60 }) != false
        else { return }
        categoriesLoading = true
        categoriesError = nil
        defer { categoriesLoading = false }
        do {
            categories = try await service.nativeSettingsCategories()
            categoriesFetchedAt = now()
        } catch { categoriesError = "settings.saveFailed" }
    }
    public func loadRecipients(force: Bool = false) async {
        guard isOnline, !recipientsLoading,
            force || recipientsFetchedAt.map({ now().timeIntervalSince($0) >= 60 }) != false
        else { return }
        recipientsLoading = true
        recipientsError = nil
        defer { recipientsLoading = false }
        do {
            recipients = try await service.nativeSettingsRecipients()
            recipientsFetchedAt = now()
        } catch { recipientsError = "settings.saveFailed" }
    }
    public func setIncludeTransfers(_ value: Bool) async {
        includeTransfers = value
        editRevision["includeTransfers", default: 0] += 1
        do {
            _ = try await saveNow("includeTransfers", value: .bool(value))
            await didChangeIncludeTransfers?()
        } catch {
            // The source optimistically keeps the toggle and intentionally ignores this failure.
        }
    }
    public func setCashCategory(_ kind: String, _ id: Int?) async {
        guard ["dividend", "interest", "fee", "tax"].contains(kind), !cashLoading, !cashSaving else { return }
        var next = object(cashRaw)
        for key in ["dividend", "interest", "fee", "tax"] where next[key] == nil { next[key] = .null }
        next[kind] = id.map { .number(Decimal($0)) } ?? .null
        cashRaw = .object(next)
        editRevision["brokerage_cash_category_ids", default: 0] += 1
        cashSaving = true
        defer { cashSaving = false }
        do {
            let result = try await saveNow("brokerage_cash_category_ids", value: cashRaw!)
            cashRaw = result.value
            cashAcknowledged = result.value
        } catch {
            cashRaw = cashAcknowledged
            show(.error, "settings.saveFailed")
        }
    }
    public func setCostBasisMethod(_ method: String) async {
        guard ["weighted_avg", "fifo", "lifo"].contains(method) else { return }
        updateApp(["costBasisMethod": .string(method)])
        do {
            _ = try await saveNow("cost_basis_method", value: .string(method))
            await didChangeCostBasis?()
        } catch { show(.error, "settings.saveFailed") }
    }
    public func resetRecurringDismissals() async {
        await clearRecurringLocalState?()
        do {
            _ = try await saveNow("dismissed_recurring_patterns", value: .array([]))
            show(.success, "settings.app.recurringDismissalsResetSuccess")
        } catch { show(.error, "settings.app.recurringDismissalsResetFailed") }
    }
    public func resetPreferences() async {
        appRaw = NativeSettingsDefaults.app
        dashboardRaw = NativeSettingsDefaults.dashboard
        sessionTierOverride = nil
        changed("app_settings", appRaw!)
        changed("dashboard_settings", dashboardRaw!)
        didChangeApp?(appRaw!)
        didChangeDashboard?(dashboardRaw!)
        includeTransfers = false
        editRevision["includeTransfers", default: 0] += 1
        show(.info, "settings.resetToDefaults")
        do {
            _ = try await saveNow("includeTransfers", value: .bool(false))
            await didResetPreferences?()
        } catch {
            // Source reset's server-only write is deliberately non-fatal.
        }
    }
    public func loadServices() async {
        guard let loadKeepServices, !servicesLoading else { return }
        servicesLoading = true
        defer { servicesLoading = false }
        do { keepServicesOnQuit = try await loadKeepServices() } catch {
            // Display default; host writer refuses unknown baseline.
        }
    }
    public func setKeepServicesOnQuit(_ value: Bool) async {
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
    private func changed(_ key: String, _ value: TaxValue) {
        editRevision[key, default: 0] += 1
        let revision = editRevision[key]!
        timers[key]?.cancel()
        timers[key] = Task { [weak self] in
            guard let self else { return }
            do { try await Task.sleep(for: delay) } catch { return }
            guard self.editRevision[key] == revision else { return }
            self.timers[key] = nil
            self.pendingDebounces = self.timers.count
            let id = UUID()
            let task = Task { [weak self] in
                guard let self else { return }
                do { _ = try await self.saveNow(key, value: value) } catch {
                    if key != "theme_settings" {
                        self.saveError = "settings.saveFailed"
                        self.saveErrorNonce += 1
                        self.show(.error, "settings.saveFailed")
                    }
                }
                self.writes[id] = nil
            }
            self.writes[id] = task
        }
        pendingDebounces = timers.count
    }
    private func saveNow(_ key: String, value: TaxValue) async throws -> NativeSettingsRecord {
        pendingWrites += 1
        defer { pendingWrites -= 1 }
        let result = try await persistence.save(key, value: value)
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
        noticeRevision += 1
        notice = .init(id: noticeRevision, kind: kind, key: key)
        didNotice?(notice!)
    }
}
