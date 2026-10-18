import Foundation

/// The server-mode parts of `VirtualDataTable` (apps/frontend/src/components/shared/
/// VirtualDataTable.tsx) that later server-paged screens share: the sort cycle sent to the
/// API, the infinite-scroll threshold, the client column filters over the loaded rows, and
/// the checkbox selection a bulk bar acts on.
public enum ServerTablePaging {
    /// `loadMoreOffset`: `clamp(floor(pageSize / 5), 15, 50)` rows before the end.
    public static func loadMoreThreshold(pageSize: Int) -> Int {
        min(50, max(15, pageSize / 5))
    }

    /// `maybeLoadMore`: the row at `index` (of the shown rows) is within the threshold of the
    /// end while more rows exist on the server.
    public static func shouldLoadMore(rowIndex: Int, shownCount: Int, threshold: Int, hasMore: Bool) -> Bool {
        hasMore && rowIndex >= shownCount - max(1, threshold)
    }
}

extension LocalTableSort {
    /// `handleSort` in server mode: a new column sorts ascending, then descending, then not at
    /// all (the API's default order).
    public static func cycled(_ current: LocalTableSort?, key: String) -> LocalTableSort? {
        guard let current, current.key == key else { return LocalTableSort(key: key, ascending: true) }
        return current.ascending ? LocalTableSort(key: key, ascending: false) : nil
    }
}

/// The client column filters of a server-mode table: a case-insensitive substring of a
/// row's raw value, over the loaded rows only (never sent to the server).
public struct ServerColumnFilters: Equatable, Sendable {
    /// In the order they were first set (the chips' order).
    public private(set) var filters: [TableColumnFilter] = []

    public init() {}

    public var isEmpty: Bool { filters.isEmpty }

    /// `activeFilterCount`.
    public var count: Int { filters.count }

    public func value(for key: String) -> String {
        filters.first { $0.key == key }?.value ?? ""
    }

    /// `setColumnFilter`: an empty value removes the filter; a changed one keeps its place.
    public mutating func set(_ key: String, to value: String) {
        if value.isEmpty {
            filters.removeAll { $0.key == key }
        } else if let index = filters.firstIndex(where: { $0.key == key }) {
            filters[index] = TableColumnFilter(key: key, value: value)
        } else {
            filters.append(TableColumnFilter(key: key, value: value))
        }
    }

    public mutating func removeAll() {
        filters = []
    }

    /// The rows whose raw value under every filtered key contains the filter text.
    public func apply<Row>(_ rows: [Row], value: (Row, String) -> TableRawValue) -> [Row] {
        guard !filters.isEmpty else { return rows }
        return rows.filter { row in
            filters.allSatisfy { filter in
                value(row, filter.key).string?.lowercased().contains(filter.value.lowercased()) ?? false
            }
        }
    }
}

/// The checkbox selection of a server-paged table: ids of loaded rows, extended with Shift
/// (a range from the last clicked row) and Command (one row), or every row matching the
/// filter ("select all matching", which the bulk bar sends as a filter with its count).
public struct ServerTableSelection: Equatable, Sendable {
    public enum Mode: Equatable, Sendable {
        /// The checked ids.
        case ids
        /// Every row the current filter matches, loaded or not.
        case filter
    }

    public private(set) var ids: Set<Int> = []
    public private(set) var mode: Mode = .ids
    /// The row a Shift range starts from: the last row toggled on its own.
    public private(set) var anchor: Int?

    public init() {}

    /// Nothing is selected: the bulk bar hides.
    public var isEmpty: Bool { ids.isEmpty && mode == .ids }

    public func contains(_ id: Int) -> Bool {
        mode == .filter || ids.contains(id)
    }

    /// The row checkbox or Command-click: toggles one row and anchors a later Shift range.
    public mutating func toggle(_ id: Int) {
        mode = .ids
        if ids.contains(id) {
            ids.remove(id)
        } else {
            ids.insert(id)
        }
        anchor = id
    }

    /// Shift-click: every row from the anchor to `id` (in the shown order) joins the
    /// selection; without an anchor it toggles the row.
    public mutating func extend(to id: Int, in order: [Int]) {
        guard let anchor, let start = order.firstIndex(of: anchor), let end = order.firstIndex(of: id) else {
            toggle(id)
            return
        }
        mode = .ids
        let range = start <= end ? start...end : end...start
        for index in range { ids.insert(order[index]) }
    }

    /// Every loaded row is checked.
    public func allSelected(_ order: [Int]) -> Bool {
        mode == .filter || (!order.isEmpty && order.allSatisfy { ids.contains($0) })
    }

    /// Some, but not all, loaded rows are checked (the tri-state header box).
    public func someSelected(_ order: [Int]) -> Bool {
        !ids.isEmpty && !allSelected(order)
    }

    /// `toggleSelectAll`: every loaded row, or none when all are checked.
    public mutating func toggleAll(_ order: [Int]) {
        if allSelected(order) {
            clear()
        } else {
            mode = .ids
            ids = Set(order)
        }
    }

    /// "Select all matching": the bulk bar's promotion to the filter (phase 3e part B).
    public mutating func selectAllMatching() {
        mode = .filter
    }

    /// The selection of rows no longer loaded is dropped (a filter change clears it all).
    public mutating func keep(only loaded: Set<Int>) {
        ids = ids.intersection(loaded)
        if let anchor, !loaded.contains(anchor) { self.anchor = nil }
    }

    public mutating func clear() {
        ids = []
        mode = .ids
        anchor = nil
    }
}
