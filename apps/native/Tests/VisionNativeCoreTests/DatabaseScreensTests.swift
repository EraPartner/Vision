import Foundation
import Testing
@testable import VisionNativeCore

/// A database admin service that answers from scripts (the last answer repeats), records
/// its calls and can hold a rows or vacuum request until released.
actor FakeDatabaseService: DatabaseAdminService {
    struct Mutation: Equatable, Sendable {
        let table: String
        let changes: [TableChange]
        let dryRun: Bool
    }

    var stats: [Result<OpenAPI.DbStats, APIError>]
    var vacuums: [Result<OpenAPI.DbVacuumResult, APIError>]
    var schemas: [Result<OpenAPI.DbEditorTableSchema, APIError>]
    var pages: [Result<OpenAPI.DbEditorRows, APIError>]
    var mutations: [Result<OpenAPI.DbEditorMutationResult, APIError>]
    private(set) var statsCalls = 0
    private(set) var vacuumTables: [String?] = []
    private(set) var queries: [TableRowsQuery] = []
    private(set) var mutationCalls: [Mutation] = []
    private var holdRows = false
    private var rowsGate: CheckedContinuation<Void, Never>?
    private var holdVacuum: Bool
    private var vacuumGate: CheckedContinuation<Void, Never>?

    init(
        stats: [Result<OpenAPI.DbStats, APIError>] = [.success(DatabaseFixture.stats)],
        vacuums: [Result<OpenAPI.DbVacuumResult, APIError>] = [.success(OpenAPI.DbVacuumResult(vacuumed: "all"))],
        schemas: [Result<OpenAPI.DbEditorTableSchema, APIError>] = [.success(DatabaseFixture.schema)],
        pages: [Result<OpenAPI.DbEditorRows, APIError>] = [.success(DatabaseFixture.page())],
        mutations: [Result<OpenAPI.DbEditorMutationResult, APIError>] = [],
        holdVacuum: Bool = false
    ) {
        self.stats = stats
        self.vacuums = vacuums
        self.schemas = schemas
        self.pages = pages
        self.mutations = mutations
        self.holdVacuum = holdVacuum
    }

    private static func next<Value>(_ script: inout [Result<Value, APIError>]) throws -> Value {
        guard !script.isEmpty else { throw APIError.network("no script") }
        return try (script.count > 1 ? script.removeFirst() : script[0]).get()
    }

    func databaseStats() async throws -> OpenAPI.DbStats {
        statsCalls += 1
        return try Self.next(&stats)
    }

    func vacuum(table: String?) async throws -> OpenAPI.DbVacuumResult {
        vacuumTables.append(table)
        if holdVacuum {
            holdVacuum = false
            await withCheckedContinuation { vacuumGate = $0 }
        }
        return try Self.next(&vacuums)
    }

    func tableSchema(_ table: String) async throws -> OpenAPI.DbEditorTableSchema {
        try Self.next(&schemas)
    }

    func tableRows(_ table: String, _ query: TableRowsQuery) async throws -> OpenAPI.DbEditorRows {
        queries.append(query)
        let result = try Self.next(&pages)
        if holdRows {
            holdRows = false
            await withCheckedContinuation { rowsGate = $0 }
        }
        return result
    }

    func mutateTable(_ table: String, changes: [TableChange], dryRun: Bool) async throws
        -> OpenAPI.DbEditorMutationResult
    {
        mutationCalls.append(Mutation(table: table, changes: changes, dryRun: dryRun))
        return try Self.next(&mutations)
    }

    func setPages(_ value: [Result<OpenAPI.DbEditorRows, APIError>]) { pages = value }
    func setMutations(_ value: [Result<OpenAPI.DbEditorMutationResult, APIError>]) { mutations = value }

    /// The next rows request waits for `releaseRows`.
    func holdNextRows() { holdRows = true }
    var isHoldingRows: Bool { rowsGate != nil }
    func releaseRows() {
        rowsGate?.resume()
        rowsGate = nil
    }

    var isHoldingVacuum: Bool { vacuumGate != nil }
    func releaseVacuum() {
        vacuumGate?.resume()
        vacuumGate = nil
    }
}

/// Counts the stats invalidations a vacuum or refresh sends to the overview.
@MainActor
final class CallCounter {
    var count = 0
}

enum DatabaseFixture {
    static let stats = OpenAPI.DbStats(
        tables: [
            OpenAPI.DbTableStat(
                schemaname: "public", tableName: "transactions", liveRows: "2453", deadRows: "1500",
                lastAutovacuum: "2026-04-24 10:15:32.123456+00", lastAutoanalyze: nil, size: "3200 kB",
                sizeBytes: "3276800"),
            OpenAPI.DbTableStat(
                schemaname: "public", tableName: "categories", liveRows: "45", deadRows: "1000", lastAutovacuum: nil,
                lastAutoanalyze: "2026-04-23T03:21:15Z", size: "64 kB", sizeBytes: "65536"),
        ],
        dbSize: "12 MB")

    static func column(
        _ name: String, type: String = "text", udt: String = "text", nullable: Bool = true, writable: Bool = true
    ) -> OpenAPI.DbEditorColumn {
        OpenAPI.DbEditorColumn(
            name: name, dataType: type, udtName: udt, nullable: nullable, hasDefault: false, generated: !writable,
            writable: writable)
    }

    static let columns = [
        column("id", type: "integer", udt: "int4", nullable: false),
        column("name"),
        column("active", type: "boolean", udt: "bool", nullable: false),
        column("meta", type: "jsonb", udt: "jsonb"),
        column("created_at", type: "timestamp with time zone", udt: "timestamptz", writable: false),
    ]

    static let schema = OpenAPI.DbEditorTableSchema(table: "categories", columns: columns, primaryKey: ["id"])

    static let rows: [[String: JSONValue]] = [
        [
            "id": .int(1), "name": .string("Food"), "active": .bool(true), "meta": .object(["a": .int(1)]),
            "created_at": .string("2026-01-01T00:00:00Z"), "__xmin": .string("100"),
        ],
        [
            "id": .int(2), "name": .null, "active": .bool(false), "meta": .null,
            "created_at": .string("2026-01-02T00:00:00Z"), "__xmin": .string("101"),
        ],
    ]

    static func page(
        rows: [[String: JSONValue]] = DatabaseFixture.rows, primaryKey: [String] = ["id"], hasMore: Bool = false,
        nextCursor: String? = nil
    ) -> OpenAPI.DbEditorRows {
        OpenAPI.DbEditorRows(
            table: "categories", columns: columns, primaryKey: primaryKey, rows: rows, total: hasMore ? nil : rows.count,
            limit: 100, hasMore: hasMore, nextCursor: nextCursor)
    }

    static let strings = DictionaryStrings(
        language: .en,
        table: [
            "dbMaintenance.allTables": "All tables", "dbMaintenance.loadError": "Failed to load database stats",
            "dbEditor.loadError": "Failed to load table data", "dbEditor.statementsApplied": "statement(s) applied",
        ])

    static func cell(_ row: Int, _ column: String) -> TableDataEditorModel.Cell {
        TableDataEditorModel.Cell(row: String(row), column: column)
    }
}

@MainActor
@Suite struct DatabaseMaintenanceModelTests {
    let strings = DatabaseFixture.strings
    let utc = TimeZone(identifier: "UTC")!

    @Test func statsLoadAndTheRowsFollowTheAppFormats() async {
        let service = FakeDatabaseService()
        let model = DatabaseMaintenanceModel(service: service)
        #expect(model.isLoading)
        #expect(model.totalSize == "—")
        await model.appear()
        #expect(!model.isLoading)
        #expect(model.totalSize == "12 MB")
        #expect(model.tableCount == 2)
        #expect(!model.showsEmptyState)
        let rows = model.rows(settings: NativeAppSettings(dateFormat: .isoDate, numberFormat: .eu), timeZone: utc)
        #expect(rows.count == 2)
        #expect(rows[0].table == "transactions")
        #expect(rows[0].liveRows == "2.453")
        #expect(rows[0].deadRows == "1.500")
        #expect(rows[0].hasManyDeadRows)
        #expect(rows[0].lastVacuum == "2026-04-24 10:15")
        #expect(rows[0].lastAnalyze == "—")
        #expect(rows[0].size == "3200 kB")
        #expect(rows[0].editorRoute == "/admin/db/transactions")
        // The warning tint starts above 1000 dead rows.
        #expect(!rows[1].hasManyDeadRows)
        #expect(rows[1].lastAnalyze == "2026-04-23 03:21")
        let us = model.rows(settings: NativeAppSettings(numberFormat: .us), timeZone: utc)
        #expect(us[0].liveRows == "2,453")
        // A fresh query is not fetched again.
        await model.appear()
        #expect(await service.statsCalls == 1)
    }

    @Test func vacuumingAllTablesToastsRefreshesAndBlocksASecondVacuum() async {
        let service = FakeDatabaseService(holdVacuum: true)
        let counter = CallCounter()
        let model = DatabaseMaintenanceModel(service: service, onStatsChanged: { counter.count += 1 })
        await model.appear()
        let running = Task { await model.vacuum(table: nil, strings: strings) }
        while !(await service.isHoldingVacuum) { await Task.yield() }
        #expect(model.isVacuuming)
        #expect(model.isVacuumingAll)
        // Vacuum all and every Run vacuum are disabled while one runs.
        await model.vacuum(table: "categories", strings: strings)
        await service.releaseVacuum()
        await running.value
        #expect(!model.isVacuuming)
        #expect(await service.vacuumTables == [nil])
        #expect(model.notice?.kind == .success)
        #expect(model.notice?.key == "dbMaintenance.vacuumSuccess")
        #expect(model.notice?.detail == "All tables")
        #expect(await service.statsCalls == 2)
        #expect(counter.count == 1)
        await model.vacuum(table: "categories", strings: strings)
        #expect(model.notice?.detail == "categories")
        #expect(await service.vacuumTables == [nil, "categories"])
        #expect(counter.count == 2)
    }

    @Test func oneTableVacuumIsNotTheAllTablesLabel() async {
        let service = FakeDatabaseService(holdVacuum: true)
        let model = DatabaseMaintenanceModel(service: service)
        let running = Task { await model.vacuum(table: "categories", strings: strings) }
        while !(await service.isHoldingVacuum) { await Task.yield() }
        #expect(model.isVacuuming)
        #expect(!model.isVacuumingAll)
        #expect(model.vacuuming == DatabaseMaintenanceModel.VacuumTarget.table("categories"))
        await service.releaseVacuum()
        await running.value
    }

    @Test func aFailedVacuumToastsTheTableAndTheMessage() async {
        let busy = APIError.client(
            APIClientError(status: 409, code: .appError, message: "VACUUM already running. Please wait."))
        let service = FakeDatabaseService(vacuums: [.failure(busy)])
        let model = DatabaseMaintenanceModel(service: service)
        await model.appear()
        await model.vacuum(table: "categories", strings: strings)
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.key == "dbMaintenance.vacuumFailed")
        #expect(model.notice?.detail == "categories: VACUUM already running. Please wait.")
        #expect(await service.statsCalls == 1)
        #expect(!model.isVacuuming)
        await model.vacuum(table: nil, strings: strings)
        #expect(model.notice?.detail == "All tables: VACUUM already running. Please wait.")
        let id = model.notice?.id ?? -1
        model.clearNotice(id)
        #expect(model.notice == nil)
    }

    @Test func authenticationFailuresShowThePlainMessage() async {
        // ADR-233: no admin token, so 401 and 403 are ordinary failures.
        let unauthorized = DatabaseMaintenanceModel(service: FakeDatabaseService(stats: [.failure(AdminFixture.auth)]))
        await unauthorized.appear()
        #expect(
            unauthorized.errorState(strings: strings)
                == AdminErrorState(title: "Failed to load database stats", body: "Admin token required"))
        #expect(!unauthorized.showsEmptyState)
        let forbidden = DatabaseMaintenanceModel(
            service: FakeDatabaseService(
                stats: [.failure(.client(APIClientError(status: 403, code: .forbidden, message: "Forbidden")))]))
        await forbidden.appear()
        #expect(
            forbidden.errorState(strings: strings)
                == AdminErrorState(title: "Failed to load database stats", body: "Forbidden"))
        let timedOut = DatabaseMaintenanceModel(service: FakeDatabaseService(stats: [.failure(.timedOut)]))
        await timedOut.appear()
        #expect(
            timedOut.errorState(strings: strings)
                == AdminErrorState(title: "Failed to load database stats", body: "apiError.timeout"))
    }

    @Test func noTablesShowTheEmptyStateAndRefreshFetchesAgain() async {
        let service = FakeDatabaseService(stats: [.success(OpenAPI.DbStats(tables: [], dbSize: "8 MB"))])
        let counter = CallCounter()
        let model = DatabaseMaintenanceModel(service: service, onStatsChanged: { counter.count += 1 })
        #expect(!model.showsEmptyState)
        await model.appear()
        #expect(model.showsEmptyState)
        #expect(model.tableCount == 0)
        await model.refresh()
        #expect(await service.statsCalls == 2)
        #expect(counter.count == 1)
    }

    @Test func timestampsParseThePostgresText() throws {
        let instant = try #require(PostgresTimestamp.parse("2026-04-24 10:15:32.5+02"))
        #expect(instant == Date(timeIntervalSince1970: 1_777_018_532.5))
        #expect(PostgresTimestamp.parse("2026-04-24T08:15:32Z") == Date(timeIntervalSince1970: 1_777_018_532))
        #expect(PostgresTimestamp.parse("2026-04-24 08:15:32+00:00") == Date(timeIntervalSince1970: 1_777_018_532))
        #expect(PostgresTimestamp.parse("yesterday") == nil)
        #expect(PostgresTimestamp.appDateTime(nil, settings: .defaults) == "—")
        #expect(PostgresTimestamp.appDateTime("", settings: .defaults) == "—")
        #expect(PostgresTimestamp.appDateTime("not a date", settings: .defaults) == "not a date")
    }
}

@Suite struct TableEditorRouteTests {
    @Test func tableRoutesEncodeOneSegmentAndDecodeIt() {
        #expect(TableEditorRoute.path(for: "transactions") == "/admin/db/transactions")
        #expect(TableEditorRoute.path(for: "my table") == "/admin/db/my%20table")
        #expect(TableEditorRoute.path(for: "a/b") == "/admin/db/a%2Fb")
        #expect(TableEditorRoute.table(forPath: "/admin/db/my%20table") == "my table")
        #expect(TableEditorRoute.table(forPath: "/admin/db/a%2Fb") == "a/b")
        #expect(TableEditorRoute.table(forPath: "/admin/db/x/") == "x")
        #expect(TableEditorRoute.table(forPath: "/admin/db/") == nil)
        #expect(TableEditorRoute.table(forPath: "/admin/db") == nil)
        #expect(TableEditorRoute.table(forPath: "/admin/db/a/b") == nil)
        #expect(TableEditorRoute.table(forPath: "/admin/dbx") == nil)
        #expect(NativeScreen.screen(forPath: "/admin/db/my%20table") == NativeScreen.tableEditor(table: "my table"))
        #expect(NativeScreen.tableEditor(table: "my table").path == "/admin/db/my%20table")
        #expect(NativeScreen.databaseMaintenance.path == "/admin/db")
        #expect(NativeScreen.screen(forPath: "/admin/db/a/b") == nil)
    }

    @Test func rowQueriesEncodeTheFiltersLikeJSONStringify() {
        #expect(TableRowsQuery().filtersParameter == nil)
        #expect(TableRowsQuery().limit == 100)
        let query = TableRowsQuery(filters: [TableFilter(column: "name", value: "fo\"o")])
        #expect(query.filtersParameter == #"[{"column":"name","op":"contains","value":"fo\"o"}]"#)
    }

    @Test func changesBecomeTheRequestItems() {
        let insert = TableChange.insert(values: ["name": .string("x")]).item
        #expect(insert.op == .insert)
        #expect(insert.values == JSONValue.object(["name": .string("x")]))
        #expect(insert.pk == nil && insert.set == nil && insert.xmin == nil)
        let update = TableChange.update(pk: ["id": .int(1)], xmin: .string("100"), set: ["name": .null]).item
        #expect(update.op == .update)
        #expect(update.pk == JSONValue.object(["id": .int(1)]))
        #expect(update.set == JSONValue.object(["name": .null]))
        #expect(update.xmin == JSONValue.string("100"))
        let delete = TableChange.delete(pk: ["id": .int(2)], xmin: nil).item
        #expect(delete.op == .delete)
        #expect(delete.xmin == nil && delete.values == nil)
    }
}

@Suite struct TableCellValueTests {
    /// `display(value)` as `text|isNull`.
    func shown(_ value: JSONValue?) -> String {
        let display = TableCellValue.display(value)
        return "\(display.text)|\(display.isNull)"
    }

    @Test func cellsDisplayLikeThePage() {
        #expect(shown(nil) == "NULL|true")
        #expect(shown(.null) == "NULL|true")
        #expect(shown(.bool(false)) == "false|false")
        #expect(shown(.int(42)) == "42|false")
        #expect(shown(.double(1.5)) == "1.5|false")
        #expect(shown(.double(3)) == "3|false")
        #expect(shown(.string("-42.50")) == "-42.50|false")
        #expect(shown(.object(["b": .int(1), "a": .array([.int(1), .string("x")])])) == #"{"a":[1,"x"],"b":1}|false"#)
        #expect(TableCellValue.editText(nil) == "")
        #expect(TableCellValue.editText(.null) == "")
        #expect(TableCellValue.editText(.object(["a": .int(1)])) == #"{"a":1}"#)
        #expect(TableCellValue.editText(.int(7)) == "7")
    }

    @Test func editsEqualToTheLoadedValueAreNoChange() {
        #expect(TableCellValue.equal(.int(5), .string("5")))
        #expect(TableCellValue.equal(.bool(true), .string("true")))
        #expect(TableCellValue.equal(.object(["a": .int(1)]), .string(#"{"a":1}"#)))
        #expect(TableCellValue.equal(nil, .null))
        #expect(TableCellValue.equal(.null, nil))
        #expect(!TableCellValue.equal(.null, .string("")))
        #expect(!TableCellValue.equal(.string("Food"), .string("food")))
        #expect(!TableCellValue.equal(.string("x"), .null))
        #expect(TableCellValue.isBoolean(DatabaseFixture.column("a", type: "boolean", udt: "bool")))
        #expect(!TableCellValue.isBoolean(DatabaseFixture.column("a")))
    }
}

@MainActor
@Suite struct TableDataEditorModelTests {
    let strings = DatabaseFixture.strings

    func loaded(_ service: FakeDatabaseService = FakeDatabaseService()) async -> TableDataEditorModel {
        let model = TableDataEditorModel(table: "categories", service: service)
        await model.appear()
        return model
    }

    @Test func theSchemaAndTheFirstPageLoad() async {
        let service = FakeDatabaseService()
        let model = TableDataEditorModel(table: "categories", service: service)
        #expect(model.isLoading)
        #expect(model.isReadOnly)
        #expect(model.columns.isEmpty)
        await model.appear()
        #expect(model.schema == DatabaseFixture.schema)
        #expect(!model.isLoading)
        #expect(!model.isReadOnly)
        #expect(model.columns.count == 5)
        #expect(model.primaryKey == ["id"])
        #expect(model.rows.count == 2)
        #expect(model.rows[0].id == "1")
        #expect(model.rowCount == 2)
        #expect(model.pageNumber == 1)
        #expect(model.refreshesMaterializedViews)
        #expect(!model.showsEmptyState)
        #expect(model.rowLabel(model.rows[1]) == "id=2")
        let queries = await service.queries
        #expect(queries == [TableRowsQuery()])
        // The page is loaded: appearing again does not fetch.
        await model.appear()
        #expect(await service.queries.count == 1)
        let other = TableDataEditorModel(table: "budgets", service: service)
        #expect(!other.refreshesMaterializedViews)
    }

    @Test func pagingStoresCursorsAndKeepsThePreviousPageWhileFetching() async {
        let first = DatabaseFixture.page(hasMore: true, nextCursor: "c1")
        let second = DatabaseFixture.page(rows: [DatabaseFixture.rows[1]])
        let service = FakeDatabaseService(pages: [.success(first), .success(second), .success(first)])
        let model = await loaded(service)
        #expect(model.canGoToNextPage)
        #expect(!model.canGoToPreviousPage)
        await service.holdNextRows()
        let moving = Task { await model.nextPage() }
        while !(await service.isHoldingRows) { await Task.yield() }
        #expect(model.pageIndex == 1)
        #expect(model.isFetching)
        #expect(model.isShowingPreviousPage)
        #expect(model.page == first)
        #expect(!model.canGoToNextPage)
        #expect(!model.canGoToPreviousPage)
        await service.releaseRows()
        await moving.value
        #expect(model.page == second)
        #expect(!model.isShowingPreviousPage)
        #expect(model.pageNumber == 2)
        #expect(model.pageCursors == [nil, "c1"])
        #expect(!model.canGoToNextPage)
        #expect(model.canGoToPreviousPage)
        await model.previousPage()
        #expect(model.pageIndex == 0)
        let queries = await service.queries
        #expect(queries.map { $0.cursor } == [nil, "c1", nil])
        await model.refresh()
        #expect(await service.queries.count == 4)
    }

    @Test func sortingCyclesAndStartsAtPageOne() async {
        let service = FakeDatabaseService(pages: [.success(DatabaseFixture.page(hasMore: true, nextCursor: "c1"))])
        let model = await loaded(service)
        await model.nextPage()
        #expect(model.pageIndex == 1)
        await model.toggleSort("name")
        #expect(model.sort == TableSort(column: "name", direction: .asc))
        #expect(model.pageIndex == 0)
        #expect(model.pageCursors == [nil])
        await model.toggleSort("name")
        #expect(model.sort == TableSort(column: "name", direction: .desc))
        await model.toggleSort("name")
        #expect(model.sort == nil)
        await model.toggleSort("id")
        #expect(model.sort == TableSort(column: "id", direction: .asc))
        let queries = await service.queries
        #expect(queries.count == 6)
        #expect(queries[2] == TableRowsQuery(sort: TableSort(column: "name", direction: .asc)))
        #expect(queries[3].sort?.direction == .desc)
        #expect(queries[4].sort == nil)
    }

    @Test func applyingFiltersSendsTheNonBlankInputsAsContains() async {
        let service = FakeDatabaseService()
        let model = await loaded(service)
        model.draftFilters = ["meta": "  ", "name": "fo", "id": "1"]
        await model.applyFilters()
        #expect(model.appliedFilters == [TableFilter(column: "id", value: "1"), TableFilter(column: "name", value: "fo")])
        let queries = await service.queries
        #expect(queries.count == 2)
        #expect(
            queries.last?.filtersParameter
                == #"[{"column":"id","op":"contains","value":"1"},{"column":"name","op":"contains","value":"fo"}]"#)
        // The same filters again keep the loaded page.
        await model.applyFilters()
        #expect(await service.queries.count == 2)
    }

    @Test func aTableWithoutAPrimaryKeyIsReadOnly() async {
        let service = FakeDatabaseService(pages: [.success(DatabaseFixture.page(primaryKey: []))])
        let model = await loaded(service)
        #expect(model.isReadOnly)
        model.addRow()
        #expect(model.newRows.isEmpty)
        #expect(model.rows[0].id.hasPrefix("readonly:0:"))
        #expect(model.rowLabel(model.rows[0]) == "1")
        let cell = TableDataEditorModel.Cell(row: model.rows[0].id, column: "name")
        #expect(!model.canEdit(cell))
        model.setValue(.string("x"), for: cell)
        model.toggleDelete(model.rows[0])
        #expect(model.changes.isEmpty)
        #expect(!model.hasPending)
    }

    @Test func newRowsAreInsertsUntilDiscarded() async {
        let model = await loaded()
        model.addRow()
        model.addRow()
        #expect(model.newRows.map { $0.id } == ["new-0", "new-1"])
        let name = TableDataEditorModel.Cell(row: "new-0", column: "name", isNew: true)
        let key = TableDataEditorModel.Cell(row: "new-0", column: "id", isNew: true)
        #expect(model.canEdit(key))
        #expect(!model.isDirty(name))
        model.beginEditing(name)
        model.editingText = "Travel"
        model.commitEditing()
        #expect(model.isDirty(name))
        #expect(model.value(name) == .string("Travel"))
        #expect(model.changes == [TableChange.insert(values: ["name": .string("Travel")]), .insert(values: [:])])
        #expect(model.pendingCount == 2)
        #expect(model.leaveGuard.hasUnsavedChanges())
        model.revertCell(name)
        #expect(!model.isDirty(name))
        model.discardNewRow("new-1")
        #expect(model.newRows.count == 1)
        model.addRow()
        #expect(model.newRows.last?.id == "new-2")
        model.discardAll()
        #expect(!model.hasPending)
        #expect(!model.leaveGuard.hasUnsavedChanges())
    }

    @Test func inlineEditingCommitsCancelsAndReverts() async {
        let model = await loaded()
        let name = DatabaseFixture.cell(1, "name")
        #expect(model.tooltipKey(name) == "dbEditor.clickToEdit")
        model.beginEditing(name)
        #expect(model.editingCell == name)
        #expect(model.editingText == "Food")
        model.editingText = "Groceries"
        model.commitEditing()
        #expect(model.editingCell == nil)
        #expect(model.value(name) == .string("Groceries"))
        #expect(model.isDirty(name))
        #expect(
            model.changes == [TableChange.update(pk: ["id": .int(1)], xmin: .string("100"), set: ["name": .string("Groceries")])])
        // Escape reverts the cell's staged value.
        model.beginEditing(name)
        #expect(model.editingText == "Groceries")
        model.editingText = "zzz"
        model.cancelEditing()
        #expect(model.value(name) == .string("Food"))
        #expect(!model.isDirty(name))
        #expect(model.edits.isEmpty)
        // Retyping the loaded value is no change.
        model.beginEditing(name)
        model.commitEditing()
        #expect(!model.isDirty(name))
        #expect(!model.hasPending)
        // Objects edit as JSON; the same JSON is no change.
        let meta = DatabaseFixture.cell(1, "meta")
        model.beginEditing(meta)
        #expect(model.editingText == #"{"a":1}"#)
        model.commitEditing()
        #expect(!model.isDirty(meta))
        // Opening another editor commits the open one (its blur).
        model.beginEditing(name)
        model.editingText = "A"
        model.beginEditing(DatabaseFixture.cell(2, "name"))
        #expect(model.value(name) == .string("A"))
        #expect(model.editingCell == DatabaseFixture.cell(2, "name"))
        #expect(model.editingText == "")
        model.cancelEditing()
        model.revertCell(name)
        #expect(!model.hasPending)
    }

    @Test func keysAndGeneratedColumnsAreLocked() async {
        let model = await loaded()
        let id = DatabaseFixture.cell(1, "id")
        #expect(model.isLocked(id))
        #expect(!model.canEdit(id))
        #expect(model.tooltipKey(id) == "dbEditor.readOnlyCol")
        model.beginEditing(id)
        #expect(model.editingCell == nil)
        let created = DatabaseFixture.cell(1, "created_at")
        #expect(!model.canEdit(created))
        #expect(model.tooltipKey(created) == "dbEditor.readOnlyCol")
        model.setValue(.string("x"), for: created)
        #expect(!model.hasPending)
    }

    @Test func setNullAppliesToEditableNullableValues() async {
        let model = await loaded()
        let name = DatabaseFixture.cell(1, "name")
        #expect(model.canSetNull(name))
        // Already NULL, or not nullable.
        #expect(!model.canSetNull(DatabaseFixture.cell(2, "name")))
        #expect(!model.canSetNull(DatabaseFixture.cell(1, "active")))
        model.setValue(.null, for: name)
        #expect(model.value(name) == .null)
        #expect(!model.canSetNull(name))
        #expect(model.changes == [TableChange.update(pk: ["id": .int(1)], xmin: .string("100"), set: ["name": .null])])
    }

    @Test func booleanCellsStageTrueAndFalse() async {
        let model = await loaded()
        let active = DatabaseFixture.cell(1, "active")
        model.beginEditing(active)
        #expect(model.editingCell == nil)
        model.setValue(.bool(false), for: active)
        #expect(model.isDirty(active))
        #expect(model.changes == [TableChange.update(pk: ["id": .int(1)], xmin: .string("100"), set: ["active": .bool(false)])])
        model.setValue(.bool(true), for: active)
        #expect(!model.isDirty(active))
        #expect(model.changes.isEmpty)
        model.revertCell(active)
        #expect(model.edits.isEmpty)
    }

    @Test func rowsAreMarkedForDeletionAndRestored() async {
        let model = await loaded()
        let first = model.rows[0]
        let second = model.rows[1]
        model.setValue(.string("x"), for: DatabaseFixture.cell(1, "name"))
        #expect(model.canRevertRow(first))
        model.toggleDelete(first)
        #expect(model.isDeleted(first))
        #expect(!model.canRevertRow(first))
        #expect(!model.canEdit(DatabaseFixture.cell(1, "name")))
        // A deleted row is one delete, whatever was edited.
        #expect(model.changes == [TableChange.delete(pk: ["id": .int(1)], xmin: .string("100"))])
        model.toggleDelete(first)
        #expect(!model.isDeleted(first))
        model.revertRow(first)
        #expect(!model.hasEdits(first))
        #expect(!model.canRevertRow(second))
        model.setValue(.string("y"), for: DatabaseFixture.cell(2, "name"))
        model.revertRow(second)
        #expect(!model.hasPending)
    }

    @Test func pendingChangesPauseSortingFilteringAndPaging() async {
        let service = FakeDatabaseService(pages: [.success(DatabaseFixture.page(hasMore: true, nextCursor: "c1"))])
        let model = await loaded(service)
        model.toggleDelete(model.rows[1])
        #expect(model.hasPending)
        #expect(!model.canGoToNextPage)
        await model.nextPage()
        await model.toggleSort("name")
        model.draftFilters = ["name": "x"]
        await model.applyFilters()
        #expect(model.pageIndex == 0)
        #expect(model.sort == nil)
        #expect(model.appliedFilters.isEmpty)
        #expect(await service.queries.count == 1)
    }

    @Test func previewOpensTheReviewAndCommitAppliesAndReloads() async {
        let statements = [
            OpenAPI.DbEditorStatement(op: "insert", preview: #"INSERT INTO "categories" ("name") VALUES ('New')"#),
            OpenAPI.DbEditorStatement(op: "update", preview: #"UPDATE "categories" SET "name" = 'x' WHERE "id" = 1"#),
            OpenAPI.DbEditorStatement(op: "delete", preview: #"DELETE FROM "categories" WHERE "id" = 2"#),
        ]
        let service = FakeDatabaseService(
            mutations: [
                .success(OpenAPI.DbEditorMutationResult(dryRun: true, count: 3, statements: statements)),
                .success(OpenAPI.DbEditorMutationResult(dryRun: false, applied: 3, results: [], refreshScheduled: true)),
            ])
        let model = await loaded(service)
        model.addRow()
        model.setValue(.string("New"), for: TableDataEditorModel.Cell(row: "new-0", column: "name", isNew: true))
        model.setValue(.string("x"), for: DatabaseFixture.cell(1, "name"))
        model.toggleDelete(model.rows[1])
        #expect(model.operationCounts == TableDataEditorModel.OperationCounts(inserts: 1, updates: 1, deletes: 1))
        #expect(model.hasDeletes)
        let changes = model.changes
        await model.preview(strings: strings)
        #expect(model.isReviewPresented)
        #expect(model.previewStatements == statements)
        #expect(model.canCommit)
        await model.commit(strings: strings)
        let calls = await service.mutationCalls
        #expect(calls == [
            FakeDatabaseService.Mutation(table: "categories", changes: changes, dryRun: true),
            FakeDatabaseService.Mutation(table: "categories", changes: changes, dryRun: false),
        ])
        #expect(model.notice?.kind == .success)
        #expect(model.notice?.key == "dbEditor.commitSuccess")
        #expect(model.notice?.detail == "3 statement(s) applied")
        #expect(!model.isReviewPresented)
        #expect(!model.hasPending)
        #expect(model.newRows.isEmpty)
        #expect(!model.isCommitting)
        #expect(model.previewStatements.isEmpty)
        #expect(model.previewedChanges == nil)
        // The table loads again.
        #expect(await service.queries.count == 2)
    }

    @Test func aFailedCommitKeepsTheDialogAndTheChanges() async {
        let conflict = APIError.client(
            APIClientError(status: 409, code: .conflict, message: "Row changed since it was loaded"))
        let service = FakeDatabaseService(
            mutations: [
                .success(
                    OpenAPI.DbEditorMutationResult(
                        dryRun: true, count: 1, statements: [OpenAPI.DbEditorStatement(op: "delete", preview: "DELETE")])),
                .failure(conflict),
            ])
        let model = await loaded(service)
        model.toggleDelete(model.rows[0])
        await model.preview(strings: strings)
        await model.commit(strings: strings)
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.key == "dbEditor.commitFailed")
        #expect(model.notice?.detail == "Row changed since it was loaded")
        #expect(model.isReviewPresented)
        #expect(model.hasPending)
        #expect(await service.queries.count == 1)
        // Cancel closes the dialog and keeps the changes.
        model.isReviewPresented = false
        #expect(model.hasPending)
    }

    @Test func aFailedPreviewToastsAndAnEmptyPreviewCannotCommit() async {
        let service = FakeDatabaseService(mutations: [.failure(.timedOut)])
        let model = await loaded(service)
        // Nothing pending: no preview.
        await model.preview(strings: strings)
        #expect(await service.mutationCalls.isEmpty)
        model.toggleDelete(model.rows[0])
        await model.preview(strings: strings)
        #expect(!model.isReviewPresented)
        #expect(model.notice?.key == "dbEditor.previewFailed")
        #expect(model.notice?.detail == "apiError.timeout")
        await service.setMutations([.success(OpenAPI.DbEditorMutationResult(dryRun: true, count: 0, statements: []))])
        await model.preview(strings: strings)
        #expect(model.isReviewPresented)
        #expect(model.previewStatements.isEmpty)
        #expect(!model.canCommit)
        await model.commit(strings: strings)
        #expect(await service.mutationCalls.count == 2)
    }

    @Test func commitSendsThePreviewedListAndTheReviewFreezesIt() async {
        let preview = OpenAPI.DbEditorMutationResult(
            dryRun: true, count: 1, statements: [OpenAPI.DbEditorStatement(op: "delete", preview: "DELETE")])
        let service = FakeDatabaseService(
            mutations: [
                .success(preview),
                .success(OpenAPI.DbEditorMutationResult(dryRun: false, applied: 1, results: [], refreshScheduled: false)),
            ])
        let model = await loaded(service)
        let first = model.rows[0]
        model.toggleDelete(first)
        let previewed = model.changes
        await model.preview(strings: strings)
        #expect(model.previewedChanges == previewed)
        #expect(model.isReviewLocked)
        // While the dialog is open the change list cannot move.
        #expect(!model.canEdit(DatabaseFixture.cell(2, "name")))
        model.setValue(.string("x"), for: DatabaseFixture.cell(2, "name"))
        model.toggleDelete(first)
        model.addRow()
        model.discardAll()
        #expect(!model.canToggleDelete)
        #expect(!model.canRevertRow(model.rows[1]))
        #expect(!model.canRefresh)
        #expect(model.changes == previewed)
        await model.commit(strings: strings)
        let calls = await service.mutationCalls
        #expect(calls == [
            FakeDatabaseService.Mutation(table: "categories", changes: previewed, dryRun: true),
            FakeDatabaseService.Mutation(table: "categories", changes: previewed, dryRun: false),
        ])
    }

    @Test func aChangeAfterThePreviewInvalidatesTheReview() async {
        let preview = OpenAPI.DbEditorMutationResult(
            dryRun: true, count: 1, statements: [OpenAPI.DbEditorStatement(op: "delete", preview: "DELETE")])
        let service = FakeDatabaseService(mutations: [.success(preview)])
        let model = await loaded(service)
        model.toggleDelete(model.rows[0])
        await model.preview(strings: strings)
        // Cancel, change the list, and the dialog shows again with the old statements.
        model.isReviewPresented = false
        model.setValue(.string("x"), for: DatabaseFixture.cell(2, "name"))
        model.isReviewPresented = true
        #expect(model.canCommit)
        await model.commit(strings: strings)
        #expect(!model.isReviewPresented)
        #expect(model.previewStatements.isEmpty)
        #expect(model.previewedChanges == nil)
        #expect(!model.canCommit)
        #expect(model.notice?.key == "dbEditor.previewFailed")
        #expect(model.hasPending)
        let calls = await service.mutationCalls
        #expect(calls.count == 1)
        #expect(calls.first?.dryRun == true)
    }

    @Test func discardClearsThePreview() async {
        let preview = OpenAPI.DbEditorMutationResult(
            dryRun: true, count: 1, statements: [OpenAPI.DbEditorStatement(op: "delete", preview: "DELETE")])
        let model = await loaded(FakeDatabaseService(mutations: [.success(preview)]))
        model.toggleDelete(model.rows[0])
        await model.preview(strings: strings)
        #expect(model.previewedChanges != nil)
        model.isReviewPresented = false
        model.discardAll()
        #expect(!model.hasPending)
        #expect(model.previewStatements.isEmpty)
        #expect(model.previewedChanges == nil)
    }

    @Test func aPreviewAnswerThatIsNotADryRunFails() async {
        let service = FakeDatabaseService(
            mutations: [
                .success(
                    OpenAPI.DbEditorMutationResult(
                        dryRun: false, count: 1, statements: [OpenAPI.DbEditorStatement(op: "delete", preview: "DELETE")]))
            ])
        let model = await loaded(service)
        model.toggleDelete(model.rows[0])
        await model.preview(strings: strings)
        #expect(!model.isReviewPresented)
        #expect(model.previewStatements.isEmpty)
        #expect(model.previewedChanges == nil)
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.key == "dbEditor.previewFailed")
        #expect(!model.canCommit)
    }

    @Test func refreshIsDisabledWhileChangesArePending() async {
        let service = FakeDatabaseService()
        let model = await loaded(service)
        #expect(model.canRefresh)
        model.toggleDelete(model.rows[0])
        #expect(!model.canRefresh)
        await model.refresh()
        #expect(await service.queries.count == 1)
        model.discardAll()
        #expect(model.canRefresh)
        await model.refresh()
        #expect(await service.queries.count == 2)
    }

    @Test func aRepeatedKeyKeepsTheLastRow() async {
        let rows: [[String: JSONValue]] = [
            ["id": .int(1), "name": .string("Old"), "__xmin": .string("100")],
            ["id": .int(1), "name": .string("New"), "__xmin": .string("200")],
        ]
        let model = await loaded(FakeDatabaseService(pages: [.success(DatabaseFixture.page(rows: rows))]))
        #expect(model.value(DatabaseFixture.cell(1, "name")) == .string("New"))
        model.toggleDelete(model.rows[0])
        #expect(model.changes == [TableChange.delete(pk: ["id": .int(1)], xmin: .string("200"))])
    }

    @Test func loadErrorsUseTheAdminErrorState() async {
        let unauthorized = await loaded(FakeDatabaseService(pages: [.failure(AdminFixture.auth)]))
        #expect(
            unauthorized.errorState(strings: strings)
                == AdminErrorState(title: "Failed to load table data", body: "Admin token required"))
        #expect(!unauthorized.isLoading)
        #expect(unauthorized.isReadOnly)
        // The schema still shows the column headers.
        #expect(unauthorized.columns.count == 5)
        let timedOut = await loaded(FakeDatabaseService(pages: [.failure(.timedOut)]))
        #expect(
            timedOut.errorState(strings: strings) == AdminErrorState(title: "Failed to load table data", body: "apiError.timeout"))
        let schemaOnly = await loaded(
            FakeDatabaseService(schemas: [.failure(.timedOut)], pages: [.success(DatabaseFixture.page())]))
        #expect(schemaOnly.errorState(strings: strings) == nil)
    }

    @Test func aFailedNewQueryDropsThePageAndARefreshKeepsIt() async {
        let service = FakeDatabaseService()
        let model = await loaded(service)
        await service.setPages([.failure(.timedOut)])
        await model.refresh()
        #expect(model.page != nil)
        #expect(model.rowsError == .timedOut)
        await model.toggleSort("name")
        #expect(model.page == nil)
        #expect(model.rowsError == .timedOut)
        #expect(model.showsEmptyState)
        await service.setPages([.success(DatabaseFixture.page())])
        await model.refresh()
        #expect(model.rowsError == nil)
        #expect(model.rows.count == 2)
    }
}

@MainActor
@Suite struct UnsavedChangesGuardTests {
    func makeShell(database: FakeDatabaseService) -> NativeShellModel {
        NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]), theme: ThemeSelection(appearance: .light),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()),
            admin: AdminFixture.screens(database: database),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(),
            accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            loadSettings: { NativeAppSettings(adminMode: true) })
    }

    @Test func pendingEditsHoldANavigationUntilStayOrLeave() async throws {
        let shell = makeShell(database: FakeDatabaseService())
        shell.show(try #require(NativeRoute("/admin/db/categories")))
        await shell.settingsSettled()
        #expect(shell.detail == .native(.tableEditor(table: "categories")))
        let editor = try #require(shell.admin.database.editor)
        await editor.appear()
        shell.setLeaveGuard(editor.leaveGuard)
        // Without changes a navigation goes straight through.
        shell.navigate(to: "/admin/db/categories?x=1")
        #expect(shell.nativeNavigationLocation.raw == "/admin/db/categories?x=1")
        editor.addRow()
        shell.navigate(to: "/transactions")
        #expect(shell.leaveConfirmation?.path == "/transactions")
        #expect(shell.route.path == "/admin/db/categories")
        // Stay on page cancels the navigation and keeps the changes.
        shell.stayOnPage()
        #expect(shell.leaveConfirmation == nil)
        #expect(editor.hasPending)
        // A navigation on the same path (only the query changes) is not held.
        shell.navigate(to: "/admin/db/categories?x=2")
        #expect(shell.leaveConfirmation == nil)
        #expect(shell.nativeNavigationLocation.raw == "/admin/db/categories?x=2")
        // The Back link, a shortcut or a menu item all go through `navigate`.
        shell.navigate(to: TableEditorRoute.maintenancePath)
        #expect(shell.leaveConfirmation?.path == "/admin/db")
        shell.leavePage()
        #expect(shell.leaveConfirmation == nil)
        #expect(!editor.hasPending)
        #expect(shell.route.path == "/admin/db")
        #expect(shell.detail == .native(.databaseMaintenance))
        let dropped = shell.admin.database.editor == nil
        #expect(dropped)
        // Leaving without a held navigation does nothing.
        shell.leavePage()
        #expect(shell.route.path == "/admin/db")
    }

    @Test func quitAsksWhileTheGuardReportsChanges() async {
        let shell = makeShell(database: FakeDatabaseService())
        #expect(!shell.hasGuardedUnsavedChanges)
        let editor = TableDataEditorModel(table: "categories", service: FakeDatabaseService())
        await editor.appear()
        shell.setLeaveGuard(editor.leaveGuard)
        #expect(!shell.hasGuardedUnsavedChanges)
        editor.addRow()
        #expect(shell.hasGuardedUnsavedChanges)
        shell.removeLeaveGuard(id: editor.leaveGuard.id)
        #expect(!shell.hasGuardedUnsavedChanges)
    }

    @Test func onlyTheRegisteringScreenRemovesItsGuard() async throws {
        let shell = makeShell(database: FakeDatabaseService())
        let editor = TableDataEditorModel(table: "categories", service: FakeDatabaseService())
        await editor.appear()
        editor.addRow()
        shell.setLeaveGuard(editor.leaveGuard)
        shell.removeLeaveGuard(id: "/admin/db/other")
        shell.navigate(to: "/transactions")
        #expect(shell.leaveConfirmation != nil)
        shell.stayOnPage()
        shell.removeLeaveGuard(id: editor.leaveGuard.id)
        shell.navigate(to: "/transactions")
        #expect(shell.leaveConfirmation == nil)
        #expect(shell.route.path == "/transactions")
    }

    @Test func theEditorKeepsPendingChangesWhenTheRouteMovesOnItsOwn() async throws {
        let shell = makeShell(database: FakeDatabaseService())
        shell.show(try #require(NativeRoute("/admin/db/categories")))
        await shell.settingsSettled()
        let editor = try #require(shell.admin.database.editor)
        await editor.appear()
        editor.addRow()
        // The command palette moved the shell: the pending changes stay for that table.
        shell.show(try #require(NativeRoute("/transactions")))
        let kept = shell.admin.database.editor === editor
        #expect(kept)
        shell.show(try #require(NativeRoute("/admin/db/categories")))
        let reused = shell.admin.database.editor === editor
        #expect(reused)
        // Another table starts fresh.
        shell.show(try #require(NativeRoute("/admin/db/budgets")))
        #expect(shell.admin.database.editor?.table == "budgets")
        let replaced = shell.admin.database.editor !== editor
        #expect(replaced)
        // Without pending changes the editor goes with the route.
        shell.show(try #require(NativeRoute("/admin/db")))
        let dropped = shell.admin.database.editor == nil
        #expect(dropped)
    }

    @Test func aMaintenanceVacuumMarksTheOverviewStatsStale() async {
        let admin = FakeAdminService()
        let screens = AdminFixture.screens(service: admin)
        await screens.overview.dbStats.appear()
        await screens.overview.dbStats.appear()
        #expect(await admin.statsCalls == 1)
        await screens.database.maintenance.vacuum(table: nil, strings: DatabaseFixture.strings)
        await screens.overview.dbStats.appear()
        #expect(await admin.statsCalls == 2)
    }
}

@Suite struct PluralStringsTests {
    let strings = DictionaryStrings(
        language: .en,
        table: [
            "x.count.one": "{count} item", "x.count.other": "{count} items", "y.count.other": "{count} things",
            "z.count": "{count} of {name}",
        ])

    @Test func theCountPicksTheCategoryAndFallsBack() {
        #expect(strings.tc("x.count", 1) == "1 item")
        #expect(strings.tc("x.count", 0) == "0 items")
        #expect(strings.tc("x.count", 2) == "2 items")
        #expect(strings.tc("y.count", 1) == "1 things")
        #expect(strings.tc("z.count", 3, ["name": "n"]) == "3 of n")
        #expect(strings.tc("missing", 1) == "missing")
        #expect(strings.tc("x.count", 1, ["count": "one"]) == "one item")
        #expect(PluralCategory.of(1, language: .nl) == .one)
        #expect(PluralCategory.of(-1, language: .en) == .other)
        #expect(PluralCategory.of(0, language: .nl) == .other)
    }
}
