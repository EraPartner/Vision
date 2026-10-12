import AppKit
import SwiftUI
import Testing
import VisionNativeCore
@testable import VisionNativeUI

actor StaticRatesService: ExchangeRatesService {
    let result: OpenAPI.ExchangeRates

    init(_ result: OpenAPI.ExchangeRates) {
        self.result = result
    }

    func exchangeRates() async throws -> OpenAPI.ExchangeRates { result }
    func refreshExchangeRates() async throws -> OpenAPI.InfoMessage { OpenAPI.InfoMessage(message: "ok") }
}

actor StaticAdminService: AdminService {
    let failing: Bool

    init(failing: Bool = false) {
        self.failing = failing
    }

    static let provider = OpenAPI.ProviderHealth(
        provider: "ecb", kind: "fx", label: "ECB", lastSuccessAt: "2026-10-09T08:05:00.000Z",
        lastErrorAt: "2026-10-09T09:30:00.000Z", lastError: "Fetch timeout after 5000ms", consecutiveFailures: 1,
        updatedAt: nil)

    private func check() throws {
        if failing { throw APIError.client(APIClientError(status: 401, code: .unauthorized, message: "Unauthorized")) }
    }

    func databaseStats() async throws -> OpenAPI.DbStats {
        try check()
        return OpenAPI.DbStats(tables: [], dbSize: "12 MB")
    }

    func providerHealth() async throws -> [OpenAPI.ProviderHealth] {
        try check()
        return [Self.provider]
    }

    func probeProvider(_ provider: String) async throws -> OpenAPI.ProbeResult {
        OpenAPI.ProbeResult(ok: true, provider: Self.provider)
    }

    func requestMetrics() async throws -> [OpenAPI.RouteMetric] {
        try check()
        return [
            OpenAPI.RouteMetric(
                route: "GET:/api/x", method: "GET", path: "/api/x", count: 10, errors: 1,
                errorRate: Decimal(string: "0.1")!, p50Ms: 12, p95Ms: nil, windowMinutes: 15)
        ]
    }

    func endpointManifest() async throws -> [OpenAPI.EndpointEntry] {
        try check()
        return [
            OpenAPI.EndpointEntry(method: "GET", path: "/api/x"),
            OpenAPI.EndpointEntry(method: "DELETE", path: "/api/x/:id"),
        ]
    }
}

/// The database pages' service: two tables, a three-column table with a primary key (or
/// without one for `readOnly`), and a dry run of one statement.
actor StaticDatabaseService: DatabaseAdminService {
    let readOnly: Bool
    let emptyStats: Bool

    init(readOnly: Bool = false, emptyStats: Bool = false) {
        self.readOnly = readOnly
        self.emptyStats = emptyStats
    }

    static let columns = [
        OpenAPI.DbEditorColumn(
            name: "id", dataType: "integer", udtName: "int4", nullable: false, hasDefault: true, generated: false,
            writable: true),
        OpenAPI.DbEditorColumn(
            name: "name", dataType: "text", udtName: "text", nullable: true, hasDefault: false, generated: false,
            writable: true),
        OpenAPI.DbEditorColumn(
            name: "active", dataType: "boolean", udtName: "bool", nullable: false, hasDefault: false, generated: false,
            writable: true),
        OpenAPI.DbEditorColumn(
            name: "meta", dataType: "jsonb", udtName: "jsonb", nullable: true, hasDefault: false, generated: false,
            writable: true),
    ]

    func databaseStats() async throws -> OpenAPI.DbStats {
        guard !emptyStats else { return OpenAPI.DbStats(tables: [], dbSize: "8 MB") }
        return OpenAPI.DbStats(
            tables: [
                OpenAPI.DbTableStat(
                    schemaname: "public", tableName: "transactions", liveRows: "2453", deadRows: "1500",
                    lastAutovacuum: "2026-04-24 10:15:32.123456+00", lastAutoanalyze: nil, size: "3200 kB",
                    sizeBytes: "3276800"),
                OpenAPI.DbTableStat(
                    schemaname: "public", tableName: "categories", liveRows: "45", deadRows: "2", lastAutovacuum: nil,
                    lastAutoanalyze: nil, size: "64 kB", sizeBytes: "65536"),
            ],
            dbSize: "12 MB")
    }

    func vacuum(table: String?) async throws -> OpenAPI.DbVacuumResult {
        OpenAPI.DbVacuumResult(vacuumed: table ?? "all")
    }

    func tableSchema(_ table: String) async throws -> OpenAPI.DbEditorTableSchema {
        OpenAPI.DbEditorTableSchema(table: table, columns: Self.columns, primaryKey: readOnly ? [] : ["id"])
    }

    func tableRows(_ table: String, _ query: TableRowsQuery) async throws -> OpenAPI.DbEditorRows {
        OpenAPI.DbEditorRows(
            table: table, columns: Self.columns, primaryKey: readOnly ? [] : ["id"],
            rows: [
                [
                    "id": .int(1), "name": .string("Food"), "active": .bool(true), "meta": .object(["a": .int(1)]),
                    "__xmin": .string("100"),
                ],
                ["id": .int(2), "name": .null, "active": .bool(false), "meta": .null, "__xmin": .string("101")],
            ],
            limit: 100, hasMore: true, nextCursor: "c1")
    }

    func mutateTable(_ table: String, changes: [TableChange], dryRun: Bool) async throws
        -> OpenAPI.DbEditorMutationResult
    {
        OpenAPI.DbEditorMutationResult(
            dryRun: dryRun, count: changes.count,
            statements: changes.map { OpenAPI.DbEditorStatement(op: $0.op, preview: "\($0.op.uppercased()) …") },
            applied: dryRun ? nil : changes.count)
    }
}

/// An audit history with one verified, partly anchored page.
@MainActor
final class StaticAuditHistory: AuditHistoryService {
    static func entry(_ sequence: Int, anchored: Bool) -> JSONValue {
        let hash = String(repeating: String(sequence % 10), count: 64)
        return .object([
            "sequence": .int(sequence), "previousHash": .string(hash), "hash": .string(hash), "version": .int(1),
            "payload": .object(["stream": .string("transactions"), "event": .string("update")]),
            "createdAt": .string("2026-01-01T00:00:00.000Z"),
            "anchorStatus": .string(anchored ? "anchored" : "pending_anchor"),
        ])
    }

    func read(_ range: AuditViewer.ReadRange) async -> JSONValue {
        .object([
            "success": .bool(true),
            "verification": .object([
                "status": .string("partially_verified"), "sequence": .int(2),
                "hash": .string(String(repeating: "2", count: 64)), "anchoredThrough": .int(1),
            ]),
            "entries": .array([Self.entry(1, anchored: true), Self.entry(2, anchored: false)]),
            "hasMore": .bool(false),
        ])
    }

    func enroll() async -> JSONValue { .object(["success": .bool(false), "cancelled": .bool(true)]) }
    func exportSnapshot() async -> JSONValue { .object(["success": .bool(false), "cancelled": .bool(true)]) }
    func exportTransfer(password: String) async -> JSONValue { .object(["success": .bool(true)]) }
    func importTransfer(password: String) async -> JSONValue { .object(["success": .bool(true)]) }
    func rotateKey() async -> JSONValue { .object(["success": .bool(true)]) }
}

/// A planned-payments service with fixed rows; `failing` fails the list.
actor StaticPlannedService: PlannedPaymentsService {
    let rows: [OpenAPI.PlannedTransaction]
    let failing: Bool

    init(rows: [OpenAPI.PlannedTransaction] = [], failing: Bool = false) {
        self.rows = rows
        self.failing = failing
    }

    func plannedPayments(includePaused: Bool) async throws -> [OpenAPI.PlannedTransaction] {
        if failing { throw APIError.network("The network connection was lost.") }
        return includePaused ? rows : rows.filter { row in row.isActive }
    }

    func setPlannedPaymentActive(id: Int, isActive: Bool) async throws -> OpenAPI.PlannedTransaction {
        guard let row = rows.first(where: { candidate in candidate.id == id }) else { throw APIError.network("missing") }
        return OpenAPI.PlannedTransaction(
            id: row.id, plannedDate: row.plannedDate, recipientName: row.recipientName, memo: row.memo,
            amount: row.amount, currency: row.currency, categoryName: row.categoryName, url: row.url,
            isRecurring: row.isRecurring, recurrencePattern: row.recurrencePattern, isLoan: row.isLoan,
            loanTermMonths: row.loanTermMonths, isExecuted: row.isExecuted, lastExecutedDate: row.lastExecutedDate,
            executedTransactionId: row.executedTransactionId, executionCount: row.executionCount,
            executions: row.executions, isActive: isActive, links: [])
    }

    func deletePlannedPayment(id: Int) async throws {}

    func transaction(id: Int) async throws -> OpenAPI.Transaction? {
        OpenAPI.Transaction(
            id: id, transactionDate: "2026-10-01", recipientName: "Landlord", memo: nil, amount: -950,
            currency: "EUR", categoryName: "Housing", links: [])
    }

    /// The local day `offset` days from today, as `planned_date`.
    static func day(_ offset: Int) -> String {
        let calendar = PlannedDates.local
        let date = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: Date())) ?? Date()
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 2026, parts.month ?? 1, parts.day ?? 1)
    }

    static var sample: [OpenAPI.PlannedTransaction] {
        [
            OpenAPI.PlannedTransaction(
                id: 1, plannedDate: day(0), recipientName: "Landlord", memo: "Rent", amount: -950, currency: "EUR",
                categoryName: "Housing", url: "https://example.com/lease", isRecurring: true,
                recurrencePattern: "monthly", isExecuted: true, executedTransactionId: 31, executionCount: 4,
                executions: [
                    OpenAPI.PlannedTransactionExecution(id: 1, executedTransactionId: 31, executionDate: day(-30))
                ],
                isActive: true, links: []),
            OpenAPI.PlannedTransaction(
                id: 2, plannedDate: day(3), memo: "Streaming", amount: Decimal(string: "-12.99")!, currency: "USD",
                categoryName: "Leisure", isRecurring: true, recurrencePattern: "every 14 days", isExecuted: false,
                executionCount: 0, isActive: true, links: []),
            OpenAPI.PlannedTransaction(
                id: 3, plannedDate: day(40), memo: "Car loan", amount: -310, currency: "EUR", isRecurring: true,
                recurrencePattern: "monthly", isLoan: true, loanTermMonths: 48, isExecuted: false, executionCount: 0,
                isActive: true, links: []),
            OpenAPI.PlannedTransaction(
                id: 4, plannedDate: day(-2), memo: "Old gym", amount: -40, currency: "XYZ", isRecurring: false,
                isExecuted: false, executionCount: 0, isActive: false, links: []),
        ]
    }
}

/// The SwiftUI screens build and lay out in both languages and appearances.
@MainActor
@Suite struct NativeScreenStructureTests {
    static let rates = OpenAPI.ExchangeRates(
        totalRates: 3,
        rates: [
            OpenAPI.ExchangeRate(
                currency: "USD", rateToEur: Decimal(string: "1.0842")!, rateDate: "2026-10-09",
                fetchedAt: "2026-10-09T15:05:00.000Z")
        ],
        fallbackRates: ["EUR": 1, "USD": Decimal(string: "0.92")!], source: "database", isStale: false,
        lastFetchedAt: nil)

    func makeShell(
        language: NativeLanguage, appearance: ThemeAppearance, failing: Bool = false,
        database: StaticDatabaseService = StaticDatabaseService(),
        planned: StaticPlannedService = StaticPlannedService(), adminMode: Bool = true
    ) -> NativeShellModel {
        let rates = ExchangeRatesModel(service: StaticRatesService(Self.rates))
        return NativeShellModel(
            strings: CatalogStrings(language: language),
            theme: ThemeSelection(appearance: appearance),
            exchangeRates: rates,
            admin: AdminScreens.make(
                service: StaticAdminService(failing: failing), database: database,
                token: AdminTokenAccess(read: { "token" }, write: { _ in true }), audit: StaticAuditHistory()),
            planned: PlannedPaymentsModel(service: planned, rates: rates),
            loadSettings: { NativeAppSettings(adminMode: adminMode) },
            onNavigate: { _ in })
    }

    func layOut<Content: View>(_ view: Content) -> NSHostingView<Content> {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: 1100, height: 760)
        host.layoutSubtreeIfNeeded()
        return host
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theExchangeRatesScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        // Loading, then loaded.
        let loading = layOut(ExchangeRatesView(model: shell.exchangeRates, shell: shell).environment(\.visionTheme, theme))
        #expect(loading.fittingSize.width > 0)
        await shell.exchangeRates.appear()
        #expect(shell.exchangeRates.data == Self.rates)
        let loaded = layOut(ExchangeRatesView(model: shell.exchangeRates, shell: shell).environment(\.visionTheme, theme))
        #expect(loaded.fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theAdminScreensLayOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let admin = shell.admin
        // Loading.
        #expect(layOut(AdminOverviewView(model: admin.overview, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        #expect(layOut(ProviderHealthView(model: admin.providers, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        #expect(layOut(EndpointLivenessView(model: admin.endpoints, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        // Loaded, with an expanded error row, a filter and an audit page.
        await admin.overview.appear()
        await admin.providers.appear()
        await admin.endpoints.appear()
        #expect(admin.overview.audit.page?.entries.count == 2)
        #expect(admin.overview.hasToken)
        admin.providers.toggleExpanded("ecb")
        admin.endpoints.filter = "delete"
        #expect(layOut(AdminOverviewView(model: admin.overview, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOut(ProviderHealthView(model: admin.providers, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        #expect(layOut(EndpointLivenessView(model: admin.endpoints, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // The empty state.
        admin.endpoints.filter = "nothing matches"
        #expect(layOut(EndpointLivenessView(model: admin.endpoints, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theDatabaseMaintenanceScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async
    {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let model = shell.admin.database.maintenance
        // Loading, then loaded.
        #expect(layOut(DatabaseMaintenanceView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        await model.appear()
        #expect(model.tableCount == 2)
        #expect(layOut(DatabaseMaintenanceView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // A finished vacuum with its toast.
        await model.vacuum(table: "categories", strings: shell.strings)
        #expect(model.notice?.key == "dbMaintenance.vacuumSuccess")
        #expect(layOut(DatabaseMaintenanceView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // The empty state.
        let empty = makeShell(language: language, appearance: appearance, database: StaticDatabaseService(emptyStats: true))
        await empty.admin.database.maintenance.appear()
        #expect(empty.admin.database.maintenance.showsEmptyState)
        #expect(layOut(DatabaseMaintenanceView(model: empty.admin.database.maintenance, shell: empty).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func theTableEditorLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance) async {
        let shell = makeShell(language: language, appearance: appearance)
        let theme = VisionTheme(selection: shell.theme)
        let model = TableDataEditorModel(table: "categories", service: StaticDatabaseService())
        // Loading, then loaded.
        #expect(layOut(TableDataEditorView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.width > 0)
        await model.appear()
        #expect(model.rows.count == 2)
        #expect(layOut(TableDataEditorView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // Pending: a new row, an edited and a deleted row, an open editor and a sort.
        model.addRow()
        model.setValue(.string("New"), for: TableDataEditorModel.Cell(row: "new-0", column: "name", isNew: true))
        model.setValue(.bool(false), for: TableDataEditorModel.Cell(row: "1", column: "active"))
        model.toggleDelete(model.rows[1])
        model.beginEditing(TableDataEditorModel.Cell(row: "1", column: "name"))
        #expect(model.hasPending)
        #expect(layOut(TableDataEditorView(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // The Review pending changes sheet, with the delete warning.
        await model.preview(strings: shell.strings)
        #expect(model.isReviewPresented)
        #expect(model.previewStatements.count == 3)
        #expect(layOut(ReviewChangesSheet(model: model, strings: shell.strings).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // Read-only: a table without a primary key.
        let readOnly = TableDataEditorModel(table: "audit_view", service: StaticDatabaseService(readOnly: true))
        await readOnly.appear()
        #expect(readOnly.isReadOnly)
        #expect(layOut(TableDataEditorView(model: readOnly, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    func layOutPlanned(_ shell: NativeShellModel) -> NSHostingView<some View> {
        layOut(
            PlannedPaymentsView(model: shell.planned, shell: shell)
                .environment(\.visionTheme, VisionTheme(selection: shell.theme)))
    }

    @Test(arguments: [NativeLanguage.en, .nl], [ThemeAppearance.light, .dark])
    func thePlannedPaymentsScreenLaysOutInEveryState(_ language: NativeLanguage, _ appearance: ThemeAppearance)
        async throws
    {
        let shell = makeShell(
            language: language, appearance: appearance, planned: StaticPlannedService(rows: StaticPlannedService.sample))
        let model = shell.planned
        // The view's own load reads `show_all` from the route, so the route and the test agree.
        shell.routeDidChange(try #require(NativeRoute("/planned?show_all=true")))
        // Loading.
        #expect(model.isLoading)
        #expect(layOutPlanned(shell).fittingSize.width > 0)
        // Loaded with paused rows: the strip, Estimated monthly and the table.
        await model.appear(showAll: true, defaultCurrency: "EUR")
        #expect(model.payments.count == 4)
        #expect(model.tablePayments.count == 4)
        #expect(model.strip.dueCount == 2)
        #expect(model.strip.windowTotal.unavailableCount == 0)
        #expect(model.estimatedMonthly.unavailableCount == 0)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        // Sorted and filtered, then filtered to nothing.
        model.table.toggleSort(PlannedColumn.amount.rawValue)
        model.table.setFilter(PlannedColumn.category.rawValue, to: "hous")
        #expect(model.visibleRows.count == 1)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        model.table.search = "nothing matches"
        #expect(model.emptyState == .noFilterResults)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        model.table.clearAll()
        // The Undo toast.
        await model.toggleActive(model.payments[1])
        #expect(model.undo != nil)
        #expect(layOutPlanned(shell).fittingSize.height > 0)
        // The Payment history dialog, loading and loaded.
        let theme = VisionTheme(selection: shell.theme)
        #expect(layOut(PlannedHistorySheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        await model.history.load(payments: model.payments)
        #expect(model.history.entries.count == 1)
        #expect(layOut(PlannedHistorySheet(model: model, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        // No payments at all, and every payment paused.
        let empty = makeShell(language: language, appearance: appearance)
        await empty.planned.appear(showAll: false, defaultCurrency: "EUR")
        #expect(empty.planned.emptyState == .noPayments)
        #expect(empty.planned.strip.dueCount == 0)
        #expect(layOutPlanned(empty).fittingSize.height > 0)
        let paused = makeShell(
            language: language, appearance: appearance,
            planned: StaticPlannedService(rows: [StaticPlannedService.sample[3]]))
        await paused.planned.appear(showAll: false, defaultCurrency: "EUR")
        #expect(paused.planned.emptyState == .allPaused || paused.planned.payments.isEmpty)
        #expect(layOutPlanned(paused).fittingSize.height > 0)
        // The error state.
        let failing = makeShell(
            language: language, appearance: appearance, planned: StaticPlannedService(failing: true))
        await failing.planned.appear(showAll: false, defaultCurrency: "EUR")
        #expect(failing.planned.error != nil)
        #expect(layOutPlanned(failing).fittingSize.height > 0)
    }

    @Test func theShellShowsThePlannedScreenWithoutAdminMode() async throws {
        let shell = makeShell(
            language: .en, appearance: .light, planned: StaticPlannedService(rows: StaticPlannedService.sample),
            adminMode: false)
        let host = layOut(ShellRootView(model: shell) { hidden in Color.clear.accessibilityHidden(hidden) })
        shell.routeDidChange(try #require(NativeRoute("/planned?show_all=true")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.plannedPayments))
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }

    @Test func theShellShowsTheDatabaseScreensForTheirRoutes() async throws {
        let shell = makeShell(language: .nl, appearance: .dark)
        let host = layOut(ShellRootView(model: shell) { hidden in Color.clear.accessibilityHidden(hidden) })
        shell.routeDidChange(try #require(NativeRoute("/admin/db")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.databaseMaintenance))
        host.layoutSubtreeIfNeeded()
        shell.routeDidChange(try #require(NativeRoute("/admin/db/categories")))
        #expect(shell.detail == .native(.tableEditor(table: "categories")))
        #expect(shell.admin.database.editor?.table == "categories")
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }

    @Test func theAdminErrorStatesLayOut() async {
        let shell = makeShell(language: .nl, appearance: .dark, failing: true)
        let theme = VisionTheme(selection: shell.theme)
        await shell.admin.providers.appear()
        #expect(shell.admin.providers.errorState(strings: shell.strings) == .authentication)
        #expect(layOut(ProviderHealthView(model: shell.admin.providers, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
        await shell.admin.overview.appear()
        #expect(layOut(AdminOverviewView(model: shell.admin.overview, shell: shell).environment(\.visionTheme, theme)).fittingSize.height > 0)
    }

    @Test func theShellHostsTheWebContentAndTheNativeScreen() async throws {
        let shell = makeShell(language: .nl, appearance: .light)
        let root = ShellRootView(model: shell) { hidden in
            Color.clear.accessibilityHidden(hidden)
        }
        let host = layOut(root)
        #expect(host.fittingSize.width > 0)
        shell.routeDidChange(try #require(NativeRoute("/admin/exchange-rates")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.exchangeRates))
        host.layoutSubtreeIfNeeded()
        #expect(!host.subviews.isEmpty)
    }

    @Test(arguments: [ThemeAppearance.light, .dark])
    func theGlassBackgroundsLayOut(_ appearance: ThemeAppearance) {
        let theme = VisionTheme(selection: ThemeSelection(appearance: appearance))
        #expect(theme.glass == ShellGlass(selection: theme.selection))
        let sidebar = layOut(SidebarGlassBackground().environment(\.visionTheme, theme))
        let detail = layOut(DetailGlassBackground().environment(\.visionTheme, theme))
        #expect(sidebar.frame.width == 1100)
        #expect(detail.frame.width == 1100)
    }

    @Test func themeColoursComeFromTheTokens() {
        let theme = VisionTheme(selection: ThemeSelection(variant: .default, appearance: .dark))
        #expect(theme.isDark && theme.colorScheme == .dark)
        #expect(theme.palette == DesignTokens.palette(.default, .dark))
        #expect(VisionTheme.fallback.colorScheme == .light)
    }
}
