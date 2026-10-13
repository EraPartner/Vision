import Foundation
import Observation

/// A column sort of the table data editor (`TableSort`).
public struct TableSort: Equatable, Hashable, Sendable {
    public enum Direction: String, Equatable, Hashable, Sendable {
        case asc
        case desc
    }

    public let column: String
    public let direction: Direction

    public init(column: String, direction: Direction) {
        self.column = column
        self.direction = direction
    }
}

/// A structured filter of `GET .../rows` (`DbFilter`); the editor only sends `contains`.
public struct TableFilter: Equatable, Hashable, Sendable {
    public let column: String
    public let op: String
    public let value: String

    public init(column: String, op: String = "contains", value: String) {
        self.column = column
        self.op = op
        self.value = value
    }
}

/// The read parameters of one rows page (`ReadParams`).
public struct TableRowsQuery: Equatable, Hashable, Sendable {
    /// `PAGE_SIZE` of useTableDataEditorData.
    public static let pageSize = 100

    public var limit: Int
    public var cursor: String?
    public var sort: TableSort?
    public var filters: [TableFilter]

    public init(
        limit: Int = TableRowsQuery.pageSize, cursor: String? = nil, sort: TableSort? = nil, filters: [TableFilter] = []
    ) {
        self.limit = limit
        self.cursor = cursor
        self.sort = sort
        self.filters = filters
    }

    /// The `filters` query value: `JSON.stringify(filters)`, or nothing for no filters.
    public var filtersParameter: String? {
        guard !filters.isEmpty else { return nil }
        let value = JSONValue.array(
            filters.map { .object(["column": .string($0.column), "op": .string($0.op), "value": .string($0.value)]) })
        return TableCellValue.json(value)
    }
}

/// One change of `POST .../mutate` (`DbChange`).
public enum TableChange: Equatable, Sendable {
    case insert(values: [String: JSONValue])
    case update(pk: [String: JSONValue], xmin: JSONValue?, set: [String: JSONValue])
    case delete(pk: [String: JSONValue], xmin: JSONValue?)

    public var op: String {
        switch self {
        case .insert: return "insert"
        case .update: return "update"
        case .delete: return "delete"
        }
    }

    /// The request item; `xmin` is left out when the row had none, like `JSON.stringify`.
    public var item: OpenAPIOperations.AdminMutateTableRows.Body.ChangesItem {
        switch self {
        case .insert(let values):
            return .init(op: op, values: .object(values))
        case .update(let pk, let xmin, let set):
            return .init(op: op, pk: .object(pk), set: .object(set), xmin: xmin)
        case .delete(let pk, let xmin):
            return .init(op: op, pk: .object(pk), xmin: xmin)
        }
    }
}

/// The API calls of `/admin/db` and `/admin/db/:table` (apps/frontend/src/lib/api/admin.ts
/// and dbEditor.ts), so tests can use a fake.
public protocol DatabaseAdminService: Sendable {
    /// `getDbStats()`.
    func databaseStats() async throws -> OpenAPI.DbStats
    /// `vacuumTable(table)`: `nil` vacuums every table.
    func vacuum(table: String?) async throws -> OpenAPI.DbVacuumResult
    /// `getTableSchema(table)`.
    func tableSchema(_ table: String) async throws -> OpenAPI.DbEditorTableSchema
    /// `getTableRows(table, params)`.
    func tableRows(_ table: String, _ query: TableRowsQuery) async throws -> OpenAPI.DbEditorRows
    /// `previewTableMutation` (`dryRun: true`) or `commitTableMutation`.
    func mutateTable(_ table: String, changes: [TableChange], dryRun: Bool) async throws
        -> OpenAPI.DbEditorMutationResult
}

extension APIClient: DatabaseAdminService {
    public func vacuum(table: String?) async throws -> OpenAPI.DbVacuumResult {
        try await send(OpenAPIOperations.AdminDatabaseVacuum(body: .init(table: table)))
    }

    public func tableSchema(_ table: String) async throws -> OpenAPI.DbEditorTableSchema {
        try await send(OpenAPIOperations.AdminGetTableSchema(table: table))
    }

    public func tableRows(_ table: String, _ query: TableRowsQuery) async throws -> OpenAPI.DbEditorRows {
        let cursor = query.cursor.flatMap { $0.isEmpty ? nil : $0 }
        return try await send(
            OpenAPIOperations.AdminGetTableRows(
                table: table, limit: query.limit, cursor: cursor, orderBy: query.sort?.column,
                dir: query.sort?.direction.rawValue, filters: query.filtersParameter))
    }

    public func mutateTable(_ table: String, changes: [TableChange], dryRun: Bool) async throws
        -> OpenAPI.DbEditorMutationResult
    {
        // The commit sends `{ changes }` only, as `commitTableMutation` does.
        try await send(
            OpenAPIOperations.AdminMutateTableRows(
                table: table, body: .init(dryRun: dryRun ? true : nil, changes: changes.map(\.item))))
    }
}

/// The route of a table's editor: `/admin/db/${encodeURIComponent(table)}`.
public enum TableEditorRoute {
    public static let maintenancePath = "/admin/db"
    static let prefix = "/admin/db/"

    /// `encodeURIComponent`'s unreserved set.
    private static let componentCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    public static func path(for table: String) -> String {
        prefix + (table.addingPercentEncoding(withAllowedCharacters: componentCharacters) ?? table)
    }

    /// The `:table` parameter of a path, decoded like React Router's `useParams`; `nil`
    /// unless the path is exactly one segment below `/admin/db/`.
    public static func table(forPath path: String) -> String? {
        guard path.hasPrefix(prefix) else { return nil }
        var segment = String(path.dropFirst(prefix.count))
        // `/admin/db/:table` also matches with a trailing slash.
        if segment.hasSuffix("/") { segment.removeLast() }
        guard !segment.isEmpty, !segment.contains("/") else { return nil }
        return segment.removingPercentEncoding ?? segment
    }
}

/// One row of the table-statistics table (`TableStatRow`), as text.
public struct DatabaseTableRow: Equatable, Sendable, Identifiable {
    public let table: String
    public let liveRows: String
    public let deadRows: String
    /// `text-warning` above 1000 dead rows.
    public let hasManyDeadRows: Bool
    public let lastVacuum: String
    public let lastAnalyze: String
    public let size: String
    /// The table name link and Browse rows.
    public let editorRoute: String

    public var id: String { table }

    public init(_ stat: OpenAPI.DbTableStat, settings: NativeAppSettings, timeZone: TimeZone = .current) {
        let locale = settings.numberFormat.locale
        table = stat.tableName
        liveRows = Self.count(stat.liveRows, locale: locale)
        deadRows = Self.count(stat.deadRows, locale: locale)
        hasManyDeadRows = (Decimal(string: stat.deadRows.trimmingCharacters(in: .whitespaces)) ?? 0) > 1000
        lastVacuum = PostgresTimestamp.appDateTime(stat.lastAutovacuum, settings: settings, timeZone: timeZone)
        lastAnalyze = PostgresTimestamp.appDateTime(stat.lastAutoanalyze, settings: settings, timeZone: timeZone)
        size = stat.size
        editorRoute = TableEditorRoute.path(for: stat.tableName)
    }

    /// `Number(text).toLocaleString(locale)` for a BIGINT estimate.
    static func count(_ text: String, locale: Locale) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return "0" }
        guard trimmed.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == "-" || $0 == ".") }),
            let value = Decimal(string: trimmed, locale: Locale(identifier: "en_US_POSIX"))
        else { return "NaN" }
        return VisionFormat.decimal(value, fractionDigits: 0, locale: locale)
    }
}

/// The state of `/admin/db` (`DbMaintenancePage`): `useDbStats()` and the vacuum mutation.
@MainActor
@Observable
public final class DatabaseMaintenanceModel {
    /// What a running vacuum covers.
    public enum VacuumTarget: Equatable, Sendable {
        case all
        case table(String)
    }

    /// `useDbStats()`: `adminKeys.dbStats`, 30 s.
    public let stats: ScreenQuery<OpenAPI.DbStats>
    /// `vacuumingTable`: set while the vacuum mutation runs.
    public private(set) var vacuuming: VacuumTarget?
    public private(set) var notice: ScreenNotice?

    @ObservationIgnored private let service: any DatabaseAdminService
    @ObservationIgnored private let onStatsChanged: (@MainActor () -> Void)?
    @ObservationIgnored private var notices = NoticeCounter()

    /// - Parameter onStatsChanged: a vacuum invalidated `adminKeys.dbStats`, which the
    ///   overview's database tile reads too.
    public init(
        service: any DatabaseAdminService, now: @escaping @Sendable () -> Date = { Date() },
        onStatsChanged: (@MainActor () -> Void)? = nil
    ) {
        self.service = service
        self.onStatsChanged = onStatsChanged
        stats = ScreenQuery(staleAfter: 30, now: now) { try await service.databaseStats() }
    }

    public func appear() async {
        await stats.appear()
    }

    /// `isLoading`: the summary skeletons, the five skeleton rows and the disabled Refresh item.
    public var isLoading: Bool { stats.isLoading }
    /// `vacuumMutation.isPending`: Vacuum all and every Run vacuum are disabled.
    public var isVacuuming: Bool { vacuuming != nil }
    /// The header button reads "Vacuuming…" only while every table is vacuumed.
    public var isVacuumingAll: Bool { vacuuming == .all }

    /// `db_size`, or "—".
    public var totalSize: String { stats.data?.dbSize ?? "—" }
    public var tableCount: Int { stats.data?.tables.count ?? 0 }
    /// The empty state: loaded without an error and no tables.
    public var showsEmptyState: Bool { !stats.isLoading && stats.error == nil && tableCount == 0 }

    /// `AdminErrorState` with `dbMaintenance.loadError`.
    public func errorState(strings: any Localizing) -> AdminErrorState? {
        stats.error.map {
            AdminErrorState(error: $0, fallbackTitle: strings.t("dbMaintenance.loadError"), strings: strings)
        }
    }

    public func rows(settings: NativeAppSettings, timeZone: TimeZone = .current) -> [DatabaseTableRow] {
        (stats.data?.tables ?? []).map { DatabaseTableRow($0, settings: settings, timeZone: timeZone) }
    }

    /// The header menu's Refresh (disabled while loading) and the empty state's button:
    /// `invalidateQueries(adminKeys.dbStats)`.
    public func refresh() async {
        onStatsChanged?()
        await stats.invalidateAndRefetch()
    }

    /// Vacuum all tables (`table: nil`) or Run vacuum on one row. No confirmation; one
    /// vacuum at a time. Toasts `dbMaintenance.vacuumSuccess` with the table or
    /// `dbMaintenance.allTables`, or `dbMaintenance.vacuumFailed` with the error, and
    /// refreshes the stats after a success.
    public func vacuum(table: String?, strings: any Localizing) async {
        guard vacuuming == nil else { return }
        vacuuming = table.map(VacuumTarget.table) ?? .all
        let label = table ?? strings.t("dbMaintenance.allTables")
        do {
            _ = try await service.vacuum(table: table)
            notice = notices.make(.success, "dbMaintenance.vacuumSuccess", detail: label)
            vacuuming = nil
            onStatsChanged?()
            await stats.invalidateAndRefetch()
        } catch {
            let message = APIErrorMessage.text(APIError.wrapping(error), strings: strings)
            notice = notices.make(.error, "dbMaintenance.vacuumFailed", detail: "\(label): \(message)")
            vacuuming = nil
        }
    }

    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
    }
}

extension APIError {
    /// Any thrown error as an `APIError`, as `ScreenQuery` records it.
    static func wrapping(_ error: any Error) -> APIError {
        if let error = error as? APIError { return error }
        if error is CancellationError { return .network("Request failed") }
        return .network(error.localizedDescription)
    }
}

/// The models of `/admin/db` and `/admin/db/:table`.
@MainActor
@Observable
public final class DatabaseScreens {
    public let maintenance: DatabaseMaintenanceModel
    /// The editor of the table route on screen. It outlives a route change only while it
    /// holds pending changes (the page moved without the native guard, e.g. from the command
    /// palette), so they are back when that table opens again.
    public private(set) var editor: TableDataEditorModel?

    @ObservationIgnored private let service: any DatabaseAdminService

    public init(
        service: any DatabaseAdminService, now: @escaping @Sendable () -> Date = { Date() },
        onStatsChanged: (@MainActor () -> Void)? = nil
    ) {
        self.service = service
        maintenance = DatabaseMaintenanceModel(service: service, now: now, onStatsChanged: onStatsChanged)
    }

    /// The route moved. A table route opens its editor (a new one for another table, as the
    /// page remounts with fresh state); any other route drops an editor without pending
    /// changes, so coming back starts fresh.
    public func routeDidChange(path: String) {
        if let table = TableEditorRoute.table(forPath: path) {
            if editor?.table != table { editor = TableDataEditorModel(table: table, service: service) }
            return
        }
        if let editor, !editor.hasPending { self.editor = nil }
    }
}
