import Foundation
import Observation

public struct HomeCategorySlice: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let count: Int
    public let route: NativeRoute
}

/// Home's independent queries keep successful data on refetch failures. Settings and
/// hidden categories resolve before filtered totals can appear.
@MainActor
@Observable
public final class HomeModel {
    public private(set) var monthly: InsightMonthlySummary?
    public private(set) var unfilteredMonthly: InsightMonthlySummary?
    public private(set) var pace: HomeSpendingPace?
    public private(set) var balances: HomeBankBalances?
    public private(set) var netWorth: HomeNetWorth?
    public private(set) var transactions: [OpenAPI.Transaction] = []
    public private(set) var filteredRecent: [OpenAPI.Transaction] = []
    public private(set) var accounts: [OpenAPI.Account] = []
    public private(set) var planned: [OpenAPI.PlannedTransaction] = []
    public private(set) var upcoming: [OpenAPI.PlannedTransaction] = []
    public private(set) var transactionCount = 0
    public private(set) var needsCategory = 0
    public private(set) var matchCount = 0
    public private(set) var exclusions = InsightExclusions()
    public private(set) var widgets = InsightWidgetVisibility(nil)
    public private(set) var widgetsLoaded = false
    public private(set) var widgetSavePending = false
    public private(set) var widgetError: String?
    public private(set) var dismissedAccounts: [String: String] = [:]
    public private(set) var dismissedUpcoming: Set<String> = []
    public private(set) var errors: [String: String] = [:]
    public private(set) var isLoading = true
    public private(set) var isFetching = false
    public private(set) var forecast: InsightForecast?
    public private(set) var forecastError: String?
    public private(set) var isForecastLoading = false
    public var forecastOptions = InsightForecastOptions()
    public var cumulativeForecast = true
    public var selectedMethods: Set<String>?
    public var graphExclusions: [String: Bool] = [:]
    public var chartSelection: String?
    public var chartRangeStart: String?
    public private(set) var forecastAccuracy: InsightForecastAccuracy?

    @ObservationIgnored private let service: any HomeService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let calendar: Calendar
    @ObservationIgnored private let readLocal: @MainActor (String) async -> JSONValue?
    @ObservationIgnored private let writeLocal: @MainActor (String, JSONValue) async -> Void
    @ObservationIgnored private var currency = "EUR"
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var inFlight: Task<Void, Never>?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var forecastRevision = UUID()
    @ObservationIgnored private var forecastTask: Task<Void, Never>?
    @ObservationIgnored private var widgetBaseline: JSONValue = .null
    @ObservationIgnored private var widgetRevision = UUID()
    @ObservationIgnored private var usesSharedUpcoming = false
    @ObservationIgnored private var upcomingDismissalRevision = UUID()
    @ObservationIgnored private var inactivityRevision = UUID()
    @ObservationIgnored private var localWriteTask: Task<Void, Never>?

    public init(
        service: any HomeService, calendar: Calendar = .current,
        now: @escaping @Sendable () -> Date = { Date() },
        readLocal: @escaping @MainActor (String) async -> JSONValue? = { _ in nil },
        writeLocal: @escaping @MainActor (String, JSONValue) async -> Void = { _, _ in }
    ) {
        self.service = service
        self.calendar = calendar
        self.now = now
        self.readLocal = readLocal
        self.writeLocal = writeLocal
    }

    public var hasExclusions: Bool { !exclusions.isEmpty }
    public var isFullPageError: Bool {
        monthly == nil && !isLoading && (errors["monthly"] != nil || errors["settings"] != nil)
    }
    public func isVisible(_ id: String) -> Bool {
        guard let widget = InsightWidget.home.first(where: { $0.id == id }) else { return false }
        return widgets.isVisible(widget, page: "dashboard")
    }

    public func appear(settings: NativeAppSettings, route: NativeRoute, force: Bool = false) async {
        let nextCurrency = settings.defaultCurrency
        let currencyChanged = nextCurrency != currency
        if currencyChanged {
            revision = UUID()
            inFlight?.cancel()
            inFlight = nil
            monthly = nil
            unfilteredMonthly = nil
            pace = nil
            balances = nil
            netWorth = nil
            transactions = []
            filteredRecent = []
            accounts = []
            fetchedAt = nil
        }
        currency = nextCurrency
        let routeOptions = InsightForecastOptions(route: route)
        let forecastChanged =
            routeOptions.mode != forecastOptions.mode
            || routeOptions.rollingDays != forecastOptions.rollingDays
        forecastOptions.mode = routeOptions.mode
        forecastOptions.rollingDays = routeOptions.rollingDays
        if !force, let fetchedAt, now().timeIntervalSince(fetchedAt) < 30, !currencyChanged {
            if forecastChanged { await loadForecast() }
            return
        }
        if let inFlight {
            await inFlight.value
            return
        }
        let token = UUID()
        revision = token
        let task = Task { [weak self] in
            guard let self else { return }
            await self.fetch(token: token)
        }
        inFlight = task
        await task.value
        if revision == token { inFlight = nil }
    }

    private func fetch(token: UUID) async {
        let widgetToken = widgetRevision
        let dismissalToken = upcomingDismissalRevision
        let inactivityToken = inactivityRevision
        let sharedUpcoming = usesSharedUpcoming
        isFetching = true
        isLoading = monthly == nil
        do {
            let resolved = try await service.homeExclusions(scope: "dashboard")
            guard token == revision, !Task.isCancelled else { return }
            if resolved != exclusions {
                monthly = nil
                filteredRecent = []
                isLoading = true
            }
            exclusions = resolved
            errors.removeValue(forKey: "settings")
        } catch {
            guard token == revision else { return }
            errors["settings"] = error.localizedDescription
            isLoading = false
            isFetching = false
            return
        }
        guard token == revision, !Task.isCancelled else { return }
        let service = service
        let currency = currency
        let exclusions = exclusions
        let today = day(now())
        let monthEnd = day(
            calendar.date(byAdding: DateComponents(month: 1, day: -1), to: monthStart(now())) ?? now())
        let weekEnd = day(calendar.date(byAdding: .day, value: 7, to: now()) ?? now())
        async let monthly = Self.result {
            try await service.homeMonthly(currency: currency, exclusions: exclusions)
        }
        async let unfiltered: HomeResult<InsightMonthlySummary>? =
            exclusions.isEmpty
            ? nil
            : await Self.result {
                try await service.homeMonthly(currency: currency, exclusions: InsightExclusions())
            }
        async let pace = Self.result { try await service.homePace(currency: currency) }
        async let balances = Self.result { try await service.homeBalances(currency: currency) }
        async let worth = Self.result { try await service.homeNetWorth(currency: currency) }
        async let transactions = Self.result {
            try await service.homeTransactions(offset: 0, limit: 50)
        }
        async let recent = Self.result {
            exclusions.isEmpty ? [] : try await Self.recent(service: service, exclusions: exclusions)
        }
        async let accounts = Self.result { try await service.homeAccounts() }
        async let planned = Self.result {
            try await service.homePlanned(start: today, end: monthEnd, limit: 200)
        }
        async let upcoming: HomeResult<[OpenAPI.PlannedTransaction]>? =
            sharedUpcoming
            ? nil
            : await Self.result {
                try await service.homePlanned(start: today, end: weekEnd, limit: 100)
            }
        async let count = Self.result { try await service.homeTransactionCount() }
        async let needsCategory = Self.result { try await service.homeNeedsCategory() }
        async let matches = Self.result { try await service.homeMatchCount() }
        async let widgetSetting = Self.result { try await service.homeWidgetSetting() }
        let monthlyAnswer = await monthly
        let unfilteredAnswer = await unfiltered ?? monthlyAnswer
        let answers = await (
            monthlyAnswer, unfilteredAnswer, pace, balances, worth, transactions, recent, accounts,
            planned, upcoming, count, needsCategory, matches, widgetSetting
        )
        guard token == revision, !Task.isCancelled else { return }
        assign(answers.0, key: "monthly", to: &self.monthly)
        assign(answers.1, key: "unfilteredMonthly", to: &unfilteredMonthly)
        assign(answers.2, key: "hero", to: &self.pace)
        assign(answers.3, key: "bankBalances", to: &self.balances)
        assign(answers.4, key: "netWorth", to: &netWorth)
        if case .success(let value) = answers.5 {
            self.transactions = value.items
            errors.removeValue(forKey: "transactions")
        } else if case .failure(let error) = answers.5 {
            errors["transactions"] = error
        }
        assignList(answers.6, key: "recentTransactions", to: &filteredRecent)
        assignList(answers.7, key: "accounts", to: &self.accounts)
        assignList(answers.8, key: "planned", to: &self.planned)
        if !usesSharedUpcoming, let answer = answers.9 {
            assignList(answer, key: "upcoming", to: &self.upcoming)
        }
        if case .success(let value) = answers.10 { transactionCount = value }
        if case .success(let value) = answers.11 { self.needsCategory = value }
        if case .success(let value) = answers.12 { matchCount = value }
        if case .success(let value) = answers.13, !widgetSavePending, widgetToken == widgetRevision {
            widgetBaseline = value.expected
            widgets = InsightWidgetVisibility(value.value)
            widgetsLoaded = true
            widgetError = nil
        } else if case .failure(let error) = answers.13, widgetToken == widgetRevision {
            widgetError = error
        }
        let storedDismissals = await readLocal("vision.home.dismissedAccountInactivity")
        guard token == revision, !Task.isCancelled else { return }
        if inactivityToken == inactivityRevision, let values = storedDismissals?.objectValue {
            dismissedAccounts = values.compactMapValues(\.stringValue)
        }
        if !usesSharedUpcoming {
            let keys =
                (await readLocal("dismissed_upcoming_planned_payments"))?.arrayValue?.compactMap(\.stringValue) ?? []
            guard token == revision, !Task.isCancelled else { return }
            if !usesSharedUpcoming, dismissalToken == upcomingDismissalRevision {
                dismissedUpcoming = Set(keys)
            }
        }
        guard token == revision, !Task.isCancelled else { return }
        isLoading = false
        isFetching = false
        if errors.isEmpty { fetchedAt = now() }
        await loadForecast()
    }

    private nonisolated static func result<T: Sendable>(_ load: @Sendable () async throws -> T) async
        -> HomeResult<T>
    {
        do { return .success(try await load()) } catch { return .failure(error.localizedDescription) }
    }
    private func assign<T>(_ result: HomeResult<T>, key: String, to value: inout T?) {
        switch result {
        case .success(let answer):
            value = answer
            errors.removeValue(forKey: key)
        case .failure(let error): errors[key] = error
        }
    }
    private func assignList<T>(_ result: HomeResult<[T]>, key: String, to value: inout [T]) {
        switch result {
        case .success(let answer):
            value = answer
            errors.removeValue(forKey: key)
        case .failure(let error): errors[key] = error
        }
    }
    /// Scan beyond excluded first pages; offsets advance over server rows, not selected rows.
    public nonisolated static func recent(service: any HomeService, exclusions: InsightExclusions)
        async throws -> [OpenAPI.Transaction]
    {
        var result: [OpenAPI.Transaction] = []
        var offset = 0
        while result.count < 5 {
            try Task.checkCancellation()
            let page = try await service.homeTransactions(offset: offset, limit: 50)
            result += page.items.filter(exclusions.includes).prefix(5 - result.count)
            offset += 50
            if offset >= page.total || page.items.count < 50 { break }
        }
        return result
    }

    public func monthlyData(for graph: String) -> InsightMonthlySummary? {
        graphExclusions[graph] == false ? unfilteredMonthly : monthly
    }
    public func recentRows() -> [OpenAPI.Transaction] {
        Array(
            (hasExclusions && graphExclusions["recentTransactions"] != false
                ? filteredRecent : transactions).prefix(5))
    }
    public func categorySlices(strings: any Localizing) -> [HomeCategorySlice] {
        let rows = transactions.filter {
            graphExclusions["categoryPie"] == false || exclusions.includes($0)
        }
        let groups = Dictionary(grouping: rows) { $0.categoryId ?? -1 }
        let sorted = groups.filter { $0.key != -1 }.sorted {
            $0.value.count == $1.value.count ? $0.key < $1.key : $0.value.count > $1.value.count
        }
        var slices = sorted.prefix(5).map { id, rows in
            let name = rows.first?.categoryName ?? ""
            let detail = name.split(separator: ":", maxSplits: 1).last.map(String.init) ?? name
            let label = String(detail.prefix(1)) + detail.dropFirst().lowercased()
            return HomeCategorySlice(
                id: String(id), name: label, count: rows.count,
                route: InsightsRoutes.drill(categoryIds: [id], label: name))
        }
        if let uncategorised = groups[-1] {
            let label = strings.t("txPage.field.uncategorized")
            slices.append(
                HomeCategorySlice(
                    id: "uncategorised", name: label, count: uncategorised.count,
                    route: InsightsRoutes.drill(uncategorised: true, label: label)))
        }
        let others = sorted.dropFirst(5)
        if !others.isEmpty {
            let label = strings.t("dashboard.other")
            slices.append(
                HomeCategorySlice(
                    id: "other", name: label, count: others.reduce(0) { $0 + $1.value.count },
                    route: InsightsRoutes.drill(categoryIds: others.map(\.key), label: label)))
        }
        return slices
    }
    public var remainingPlanned: [OpenAPI.PlannedTransaction] {
        planned.filter { !($0.isExecuted && !$0.isRecurring) }
    }
    public var upcomingRows: [OpenAPI.PlannedTransaction] {
        Array(
            upcoming.filter {
                !($0.isExecuted && !$0.isRecurring)
                    && !dismissedUpcoming.contains("\($0.id):\($0.plannedDate.prefix(10))")
            }.sorted { ($0.plannedDate, $0.id) < ($1.plannedDate, $1.id) }.prefix(5))
    }
    /// The shell banner owns the source's shared query and occurrence storage in a native graph.
    public func useSharedUpcoming() {
        usesSharedUpcoming = true
        errors.removeValue(forKey: "upcoming")
    }
    public func applySharedUpcoming(_ rows: [OpenAPI.PlannedTransaction]) {
        useSharedUpcoming()
        upcoming = rows
    }
    /// Receipt-free mirror; only the shared banner owner persists occurrence dismissals.
    public func applyUpcomingDismissals(_ keys: [String]) {
        useSharedUpcoming()
        upcomingDismissalRevision = UUID()
        dismissedUpcoming = Set(keys)
    }
    public var staleAccounts: [HomeBankBalances.Account] {
        let cutoff = day(now().addingTimeInterval(-30 * 86_400))
        return Array(
            (balances?.accounts ?? []).filter {
                !$0.last_transaction.isEmpty && String($0.last_transaction.prefix(10)) < cutoff
                    && dismissedAccounts[String($0.id)] != String($0.last_transaction.prefix(10))
            }.prefix(3))
    }
    public func dismissInactivity(_ account: HomeBankBalances.Account) async {
        inactivityRevision = UUID()
        dismissedAccounts[String(account.id)] = String(account.last_transaction.prefix(10))
        await persistLocal(
            "vision.home.dismissedAccountInactivity",
            .object(dismissedAccounts.mapValues(JSONValue.string)))
    }
    public func restoreInactivity() async {
        inactivityRevision = UUID()
        dismissedAccounts = [:]
        await persistLocal("vision.home.dismissedAccountInactivity", .object([:]))
    }
    private func persistLocal(_ key: String, _ value: JSONValue) async {
        let previous = localWriteTask
        let write = writeLocal
        let task = Task {
            await previous?.value
            await write(key, value)
        }
        localWriteTask = task
        await task.value
    }
    /// Drain accepted inactivity writes before a restore replaces frontend storage.
    public func flushLocalStorage() async { await localWriteTask?.value }

    public func setWidget(_ id: String, visible: Bool) async {
        await updateWidgets { $0.set(id, visible: visible, page: "dashboard") }
    }
    public func allWidgets(visible: Bool) async {
        await updateWidgets { value in
            for widget in InsightWidget.home { value.set(widget.id, visible: visible, page: "dashboard") }
        }
    }
    public func resetWidgets() async { await updateWidgets { $0.reset(page: "dashboard") } }
    private func updateWidgets(_ change: (inout InsightWidgetVisibility) -> Void) async {
        guard widgetsLoaded, !widgetSavePending else { return }
        let old = widgets
        change(&widgets)
        widgetSavePending = true
        widgetRevision = UUID()
        widgetError = nil
        do {
            let saved = try await service.saveHomeWidgets(widgets.json, expected: widgetBaseline)
            widgetBaseline = saved.expected
            widgets = InsightWidgetVisibility(saved.value)
        } catch {
            widgets = old
            widgetError = error.localizedDescription
        }
        widgetRevision = UUID()
        widgetSavePending = false
    }
    public func loadForecast() async {
        forecastTask?.cancel()
        let token = UUID()
        forecastRevision = token
        let options = forecastOptions
        let exclusions = exclusions
        let currency = currency
        let service = service
        isForecastLoading = true
        forecastError = nil
        forecast = nil
        let task = Task { [weak self] in
            let result = await Self.result {
                try await service.homeForecast(currency: currency, exclusions: exclusions, options: options)
            }
            guard let self, self.forecastRevision == token, !Task.isCancelled else { return }
            switch result {
            case .success(let value): self.forecast = value
            case .failure(let error): self.forecastError = error
            }
            self.isForecastLoading = false
        }
        forecastTask = task
        await task.value
    }
    public var visibleMethods: Set<String> {
        selectedMethods ?? Set(forecast?.defaultMethod.map { [$0] } ?? [])
    }
    public func toggleMethod(_ id: String) {
        var next = visibleMethods
        if next.contains(id) { next.remove(id) } else { next.insert(id) }
        selectedMethods = next
    }
    public func loadDiagnostics() async {
        forecastOptions.diagnostics = true
        async let accuracy = Self.result { try await self.service.homeForecastAccuracy() }
        if forecastOptions.mode == .rolling { await loadForecast() }
        if case .success(let value) = await accuracy { forecastAccuracy = value }
    }
    public func invalidate() {
        fetchedAt = nil
        revision = UUID()
        inFlight?.cancel()
        inFlight = nil
        forecastRevision = UUID()
        forecastTask?.cancel()
    }
    private func day(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
    private func monthStart(_ date: Date) -> Date {
        calendar.date(from: calendar.dateComponents([.year, .month], from: date)) ?? date
    }
}

private enum HomeResult<Value: Sendable>: Sendable {
    case success(Value)
    case failure(String)
}
