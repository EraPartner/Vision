import Foundation
import Observation

/// The state of `/admin/db/:table` (`TableDataEditorPage`, ADR-101): the table's schema, the
/// keyset-paged rows with sort and filters (`useTableRows`), the staged edits, deletions and
/// new rows, and the dry-run preview and commit (`useTableMutationData`).
@MainActor
@Observable
public final class TableDataEditorModel {
    /// A pending insert (`NewRow`, temp id `new-N`).
    public struct NewRow: Equatable, Sendable, Identifiable {
        public let id: String
        public var values: [String: JSONValue]
    }

    /// A loaded row and its key (`rowKey`): the primary-key values, or its position and
    /// content on a table without a primary key.
    public struct Row: Equatable, Sendable, Identifiable {
        public let id: String
        public let index: Int
        public let values: [String: JSONValue]
    }

    /// One grid cell: a loaded row's key or a new row's temp id, and a column.
    public struct Cell: Hashable, Sendable {
        public let row: String
        public let column: String
        public let isNew: Bool

        public init(row: String, column: String, isNew: Bool = false) {
            self.row = row
            self.column = column
            self.isNew = isNew
        }
    }

    /// The per-operation counts of `dbEditor.commitSummary`.
    public struct OperationCounts: Equatable, Sendable {
        public var inserts = 0
        public var updates = 0
        public var deletes = 0
    }

    /// `MATVIEW_BASE_TABLES`: the tables whose commits refresh the dashboard views.
    public static let materializedViewBaseTables: Set<String> = ["transactions", "recipients", "categories"]

    public let table: String

    /// `GET .../schema`: the columns and primary key, shown before the first page arrives.
    public private(set) var schema: OpenAPI.DbEditorTableSchema?
    public private(set) var schemaError: APIError?

    /// The page on screen. While another page loads it stays (`placeholderData`).
    public private(set) var page: OpenAPI.DbEditorRows?
    public private(set) var rowsError: APIError?
    /// A rows request is in flight (`isFetching`).
    public private(set) var isFetching = false
    /// The zero-based page number and the cursors of the visited pages (`pageCursors`).
    public private(set) var pageIndex = 0
    public private(set) var pageCursors: [String?] = [nil]
    public private(set) var sort: TableSort?
    /// The per-column filter inputs, applied with Apply filters or Enter.
    public var draftFilters: [String: String] = [:]
    public private(set) var appliedFilters: [TableFilter] = []

    /// Staged values of loaded rows, by row key and column.
    public private(set) var edits: [String: [String: JSONValue]] = [:]
    public private(set) var deletes: Set<String> = []
    public private(set) var newRows: [NewRow] = []

    /// The cell whose inline editor is open, and its text.
    public private(set) var editingCell: Cell?
    public var editingText = ""

    /// `previewMutation.isPending`.
    public private(set) var isPreviewing = false
    /// `commitMutation.isPending`.
    public private(set) var isCommitting = false
    /// The Review pending changes dialog; dismissing it (Cancel, Esc) keeps the changes.
    public var isReviewPresented = false
    /// The dry run's statements.
    public private(set) var previewStatements: [OpenAPI.DbEditorStatement] = []
    /// The change list the dry run was sent with; Commit sends exactly this list.
    public private(set) var previewedChanges: [TableChange]?
    public private(set) var notice: ScreenNotice?

    @ObservationIgnored private let service: any DatabaseAdminService
    @ObservationIgnored private var notices = NoticeCounter()
    @ObservationIgnored private var tempSequence = 0
    /// The query `page` answers.
    @ObservationIgnored private var loadedQuery: TableRowsQuery?
    /// `rowsByKey`: the loaded rows by key; the last row wins a repeated key, like the web's `Map`.
    @ObservationIgnored private var rowsByKey: [String: Row] = [:]
    @ObservationIgnored private var generation = 0

    public init(table: String, service: any DatabaseAdminService) {
        self.table = table
        self.service = service
    }

    // MARK: Loading

    /// The query of the current page, sort and filters.
    public var query: TableRowsQuery {
        TableRowsQuery(cursor: pageCursors[pageIndex], sort: sort, filters: appliedFilters)
    }

    /// `query.isLoading`: no page and no error yet.
    public var isLoading: Bool { page == nil && rowsError == nil }
    /// The background-query cue: a new page is loading behind the previous one.
    public var isShowingPreviousPage: Bool { isFetching && page != nil && loadedQuery != query }

    /// The page mounted: the schema once, and the rows unless the current page is loaded.
    public func appear() async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadSchema() }
            group.addTask { await self.load() }
        }
    }

    private func loadSchema() async {
        guard schema == nil else { return }
        do {
            schema = try await service.tableSchema(table)
            schemaError = nil
        } catch is CancellationError {
            return
        } catch {
            schemaError = APIError.wrapping(error)
        }
    }

    /// Fetches the current query. A newer request replaces an older one; the previous page
    /// stays on screen until the answer arrives, and an error on a new query clears it.
    private func load(force: Bool = false) async {
        let current = query
        if !force, current == loadedQuery, page != nil { return }
        generation += 1
        let request = generation
        if current != loadedQuery { rowsError = nil }
        isFetching = true
        do {
            let result = try await service.tableRows(table, current)
            guard request == generation else { return }
            show(result)
            loadedQuery = current
            rowsError = nil
        } catch {
            guard request == generation else { return }
            if !(error is CancellationError) {
                if current != loadedQuery {
                    show(nil)
                    loadedQuery = nil
                }
                rowsError = APIError.wrapping(error)
            }
        }
        isFetching = false
    }

    /// The header menu's Refresh: disabled while fetching, while changes are pending (a
    /// reload could change the staged rows' `__xmin` under the change list) and while a
    /// preview or the Review dialog is open.
    public var canRefresh: Bool { !isFetching && !hasPending && !isReviewLocked }

    /// Fetch the current page again.
    public func refresh() async {
        guard canRefresh else { return }
        await load(force: true)
    }

    /// `AdminErrorState` with `dbEditor.loadError`: the rows error, or the schema's while
    /// no page has loaded.
    public func errorState(strings: any Localizing) -> AdminErrorState? {
        guard let error = rowsError ?? (page == nil ? schemaError : nil) else { return nil }
        return AdminErrorState(error: error, fallbackTitle: strings.t("dbEditor.loadError"), strings: strings)
    }

    // MARK: Columns and rows

    public var columns: [OpenAPI.DbEditorColumn] { page?.columns ?? schema?.columns ?? [] }
    /// The loaded page's primary key; the schema's while no page is shown.
    public var primaryKey: [String] { page?.primaryKey ?? schema?.primaryKey ?? [] }
    /// `readOnly`: loading, or a table without a primary key.
    public var isReadOnly: Bool { isLoading || (page?.primaryKey ?? []).isEmpty }
    /// The table's dashboard warning (`dbEditor.warningMatview`).
    public var refreshesMaterializedViews: Bool { Self.materializedViewBaseTables.contains(table) }

    /// The loaded page's rows with their keys.
    public private(set) var rows: [Row] = []

    private func show(_ next: OpenAPI.DbEditorRows?) {
        page = next
        let keys = next?.primaryKey ?? []
        rows = (next?.rows ?? []).enumerated().map { index, values in
            Row(id: Self.rowKey(values, primaryKey: keys, index: index), index: index, values: values)
        }
        rowsByKey = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    /// `rowsOnPage`.
    public var rowCount: Int { page?.rows.count ?? 0 }
    /// The footer's `Page {page}`.
    public var pageNumber: Int { pageIndex + 1 }
    public var showsEmptyState: Bool { !isLoading && rowCount == 0 && newRows.isEmpty }

    /// `rowKey`: the primary-key values (separated so `(1, 23)` and `(12, 3)` differ), or
    /// `readonly:<index>:<row JSON>` without a primary key.
    static func rowKey(_ row: [String: JSONValue], primaryKey: [String], index: Int) -> String {
        if !primaryKey.isEmpty {
            return primaryKey.map { row[$0].map(TableCellValue.jsString) ?? "undefined" }.joined(separator: "\u{1F}")
        }
        return "readonly:\(index):\(TableCellValue.json(.object(row)))"
    }

    /// The row part of `dbEditor.cellLabel`: `name=value, …` of the primary key, or the
    /// row's position.
    public func rowLabel(_ row: Row) -> String {
        guard !primaryKey.isEmpty else { return String(row.index + 1) }
        return primaryKey.map { "\($0)=\(row.values[$0].map(TableCellValue.jsString) ?? "undefined")" }
            .joined(separator: ", ")
    }

    // MARK: Sort, filters and paging

    /// A column title: ascending, descending, unsorted; back to page 1. Disabled while
    /// changes are pending.
    public func toggleSort(_ column: String) async {
        guard !hasPending else { return }
        if let sort, sort.column == column {
            self.sort = sort.direction == .asc ? TableSort(column: column, direction: .desc) : nil
        } else {
            sort = TableSort(column: column, direction: .asc)
        }
        resetPaging()
        await load()
    }

    /// Apply filters (or Enter in a filter input): every non-blank input becomes a
    /// `contains` filter; back to page 1. Disabled while changes are pending.
    public func applyFilters() async {
        guard !hasPending else { return }
        let order = columns.map(\.name)
        let named = draftFilters.keys.sorted { lhs, rhs in
            let left = order.firstIndex(of: lhs) ?? Int.max
            let right = order.firstIndex(of: rhs) ?? Int.max
            return left == right ? lhs < rhs : left < right
        }
        appliedFilters = named.compactMap { column in
            guard let value = draftFilters[column], !value.trimmingCharacters(in: .whitespaces).isEmpty else {
                return nil
            }
            return TableFilter(column: column, value: value)
        }
        resetPaging()
        await load()
    }

    private func resetPaging() {
        pageIndex = 0
        pageCursors = [nil]
    }

    public var canGoToPreviousPage: Bool { pageIndex > 0 && !hasPending && !isFetching }
    public var canGoToNextPage: Bool { (page?.hasMore ?? false) && !hasPending && !isFetching }

    public func previousPage() async {
        guard canGoToPreviousPage else { return }
        pageIndex -= 1
        await load()
    }

    /// Stores `nextCursor` after the current page and advances.
    public func nextPage() async {
        guard canGoToNextPage, let cursor = page?.nextCursor else { return }
        pageCursors = Array(pageCursors.prefix(pageIndex + 1)) + [cursor]
        pageIndex += 1
        await load()
    }

    // MARK: Pending changes

    /// The change list (`changes`): new rows first, then deletions and real updates of the
    /// loaded rows in their order. Rows of a table without a primary key never change.
    public var changes: [TableChange] {
        var out = newRows.map { TableChange.insert(values: $0.values) }
        let keys = primaryKey
        guard !(page?.primaryKey ?? []).isEmpty else { return out }
        var seen = Set<String>()
        for first in rows where seen.insert(first.id).inserted {
            let row = rowsByKey[first.id] ?? first
            var pk: [String: JSONValue] = [:]
            for name in keys { pk[name] = row.values[name] }
            let xmin = row.values["__xmin"]
            if deletes.contains(row.id) {
                out.append(.delete(pk: pk, xmin: xmin))
                continue
            }
            guard let edited = edits[row.id] else { continue }
            var set: [String: JSONValue] = [:]
            for (column, value) in edited where !TableCellValue.equal(row.values[column], value) {
                set[column] = value
            }
            if !set.isEmpty { out.append(.update(pk: pk, xmin: xmin, set: set)) }
        }
        return out
    }

    public var pendingCount: Int { changes.count }
    /// Paging, sorting and filtering pause, the pending bar shows and leaving asks first.
    public var hasPending: Bool { pendingCount > 0 }

    public var operationCounts: OperationCounts {
        var counts = OperationCounts()
        for change in changes {
            switch change {
            case .insert: counts.inserts += 1
            case .update: counts.updates += 1
            case .delete: counts.deletes += 1
            }
        }
        return counts
    }

    /// Deletes make the commit button destructive and show `dbEditor.deleteWarning`.
    public var hasDeletes: Bool { operationCounts.deletes > 0 }

    /// A dry run is in flight or the Review dialog is open (or committing): the change list
    /// is frozen, so cell edits, Add row, Discard, the row menus and Refresh are disabled.
    public var isReviewLocked: Bool { isPreviewing || isReviewPresented || isCommitting }

    /// Add row (disabled when read-only): a blank insert row.
    public func addRow() {
        guard !isReadOnly, !isReviewLocked else { return }
        newRows.append(NewRow(id: "new-\(tempSequence)", values: [:]))
        tempSequence += 1
    }

    /// Discard new row.
    public func discardNewRow(_ id: String) {
        guard !isReviewLocked else { return }
        newRows.removeAll { $0.id == id }
        if editingCell?.isNew == true, editingCell?.row == id { editingCell = nil }
    }

    /// Discard changes: every edit, deletion and new row, without confirmation.
    public func discardAll() {
        guard !isReviewLocked else { return }
        resetPending()
    }

    /// Drops the staged state and the preview (Discard, a successful commit, Leave and discard).
    private func resetPending() {
        edits = [:]
        deletes = []
        newRows = []
        editingCell = nil
        clearPreview()
    }

    private func clearPreview() {
        previewStatements = []
        previewedChanges = nil
    }

    public func isDeleted(_ row: Row) -> Bool { deletes.contains(row.id) }
    public func hasEdits(_ row: Row) -> Bool { !(edits[row.id] ?? [:]).isEmpty }

    public func canRevertRow(_ row: Row) -> Bool {
        !isReadOnly && !isReviewLocked && hasEdits(row) && !isDeleted(row)
    }

    /// Mark row for deletion / Undo delete: disabled when read-only or while reviewing.
    public var canToggleDelete: Bool { !isReadOnly && !isReviewLocked }

    /// Revert changes to this row (disabled when read-only, without edits or deleted).
    public func revertRow(_ row: Row) {
        guard canRevertRow(row) else { return }
        edits[row.id] = nil
    }

    /// Mark row for deletion / Undo delete (disabled when read-only).
    public func toggleDelete(_ row: Row) {
        guard canToggleDelete else { return }
        if deletes.contains(row.id) {
            deletes.remove(row.id)
        } else {
            deletes.insert(row.id)
            if editingCell?.row == row.id, editingCell?.isNew == false { editingCell = nil }
        }
    }

    // MARK: Cells

    private func column(_ name: String) -> OpenAPI.DbEditorColumn? {
        columns.first { $0.name == name }
    }

    private func loadedRow(_ key: String) -> Row? {
        rowsByKey[key]
    }

    /// The value a cell shows: the staged value, else the loaded one; `nil` is no value.
    public func value(_ cell: Cell) -> JSONValue? {
        if cell.isNew { return newRows.first { $0.id == cell.row }?.values[cell.column] }
        if let staged = edits[cell.row]?[cell.column] { return staged }
        return loadedRow(cell.row)?.values[cell.column]
    }

    /// A dirty cell is highlighted and offers Revert cell change.
    public func isDirty(_ cell: Cell) -> Bool {
        if cell.isNew { return newRows.first { $0.id == cell.row }?.values[cell.column] != nil }
        guard let staged = edits[cell.row]?[cell.column] else { return false }
        return !TableCellValue.equal(loadedRow(cell.row)?.values[cell.column], staged)
    }

    /// Primary keys are locked on loaded rows: they identify the row in the UPDATE and DELETE.
    public func isLocked(_ cell: Cell) -> Bool {
        !cell.isNew && primaryKey.contains(cell.column)
    }

    /// Writable, not a locked key, not on a deleted row, not on a read-only table, and not
    /// while a preview or the Review dialog is open.
    public func canEdit(_ cell: Cell) -> Bool {
        guard !isReviewLocked, let column = column(cell.column), column.writable else { return false }
        if cell.isNew { return newRows.contains { $0.id == cell.row } }
        return !isReadOnly && !isLocked(cell) && !deletes.contains(cell.row)
    }

    /// Set NULL shows on an editable, nullable cell that is not NULL.
    public func canSetNull(_ cell: Cell) -> Bool {
        guard let column = column(cell.column), column.nullable, canEdit(cell) else { return false }
        return !TableCellValue.display(value(cell)).isNull
    }

    /// The cell tooltip: `dbEditor.clickToEdit` or `dbEditor.readOnlyCol`.
    public func tooltipKey(_ cell: Cell) -> String {
        guard !isLocked(cell), column(cell.column)?.writable == true else { return "dbEditor.readOnlyCol" }
        return "dbEditor.clickToEdit"
    }

    /// Stages a value: typed text, a checkbox's `true`/`false`, or `null` from Set NULL.
    public func setValue(_ value: JSONValue, for cell: Cell) {
        guard canEdit(cell) else { return }
        if cell.isNew {
            guard let index = newRows.firstIndex(where: { $0.id == cell.row }) else { return }
            newRows[index].values[cell.column] = value
        } else {
            edits[cell.row, default: [:]][cell.column] = value
        }
    }

    /// Revert cell change: drops the staged value (and an emptied row's entry).
    public func revertCell(_ cell: Cell) {
        guard !isReviewLocked else { return }
        if cell.isNew {
            guard let index = newRows.firstIndex(where: { $0.id == cell.row }) else { return }
            newRows[index].values[cell.column] = nil
            return
        }
        guard var row = edits[cell.row], row[cell.column] != nil else { return }
        row[cell.column] = nil
        edits[cell.row] = row.isEmpty ? nil : row
    }

    /// A click, Enter or Space opens the inline editor, prefilled (objects as JSON). An
    /// open editor elsewhere commits first, as its blur does.
    public func beginEditing(_ cell: Cell) {
        guard canEdit(cell), let column = column(cell.column), !TableCellValue.isBoolean(column) else { return }
        if let open = editingCell, open != cell { commitEditing() }
        editingText = TableCellValue.editText(value(cell))
        editingCell = cell
    }

    /// Enter or blur: stages the typed text and closes the editor.
    public func commitEditing() {
        guard let cell = editingCell else { return }
        editingCell = nil
        setValue(.string(editingText), for: cell)
    }

    /// Escape: reverts the cell's staged value and closes the editor.
    public func cancelEditing() {
        guard let cell = editingCell else { return }
        editingCell = nil
        revertCell(cell)
    }

    // MARK: Preview and commit

    /// Preview SQL (disabled while previewing): the dry run, then the Review dialog, or the
    /// `dbEditor.previewFailed` toast. The sent list is kept for Commit; an answer that is
    /// not a dry run counts as a failed preview.
    public func preview(strings: any Localizing) async {
        guard !isReviewLocked, hasPending else { return }
        if editingCell != nil { commitEditing() }
        let sent = changes
        clearPreview()
        isPreviewing = true
        do {
            let result = try await service.mutateTable(table, changes: sent, dryRun: true)
            if result.dryRun {
                previewStatements = result.statements ?? []
                previewedChanges = sent
                isReviewPresented = true
            } else {
                notice = notices.make(.error, "dbEditor.previewFailed")
            }
        } catch {
            notice = notices.make(
                .error, "dbEditor.previewFailed",
                detail: APIErrorMessage.text(APIError.wrapping(error), strings: strings))
        }
        isPreviewing = false
    }

    /// Commit is disabled while committing and without a previewed change list or statements.
    public var canCommit: Bool { !isCommitting && previewedChanges != nil && !previewStatements.isEmpty }

    /// Commit to database: one transaction with exactly the previewed change list; on
    /// success the `dbEditor.commitSuccess` toast with the applied count, the dialog closes,
    /// the staged state is discarded and the rows load again; on failure the
    /// `dbEditor.commitFailed` toast and the dialog stays. When the change list no longer
    /// matches the preview, the dialog closes and the `dbEditor.previewFailed` toast asks
    /// for a new preview; nothing is sent.
    public func commit(strings: any Localizing) async {
        guard canCommit, let sent = previewedChanges else { return }
        guard sent == changes else {
            isReviewPresented = false
            clearPreview()
            notice = notices.make(.error, "dbEditor.previewFailed")
            return
        }
        isCommitting = true
        do {
            let result = try await service.mutateTable(table, changes: sent, dryRun: false)
            notice = notices.make(
                .success, "dbEditor.commitSuccess",
                detail: "\(result.applied ?? 0) \(strings.t("dbEditor.statementsApplied"))")
            isCommitting = false
            isReviewPresented = false
            resetPending()
            await load(force: true)
        } catch {
            notice = notices.make(
                .error, "dbEditor.commitFailed",
                detail: APIErrorMessage.text(APIError.wrapping(error), strings: strings))
            isCommitting = false
        }
    }

    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    public func clearNotice(_ id: Int) {
        if notice?.id == id { notice = nil }
    }

    // MARK: Leaving

    /// `useUnsavedChanges(hasPending)`: the shell asks before it leaves the table's route,
    /// and Leave and discard drops the staged state.
    public var leaveGuard: NativeLeaveGuard {
        NativeLeaveGuard(
            id: TableEditorRoute.path(for: table),
            hasUnsavedChanges: { [weak self] in self?.hasPending ?? false },
            discard: { [weak self] in self?.resetPending() })
    }
}
