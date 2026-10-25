import Foundation

/// A row field as `VirtualDataTable` reads it for search, column filters and sort: the raw
/// value under the column's key, not the rendered cell.
public enum TableRawValue: Equatable, Sendable {
    case text(String)
    case number(Decimal)
    case bool(Bool)
    /// `null` or `undefined`.
    case none

    /// `String(value)`; `nil` for `null` and `undefined`, which never match.
    public var string: String? {
        switch self {
        case .text(let text): return text
        case .number(let number): return VisionFormat.plain(number)
        case .bool(let flag): return flag ? "true" : "false"
        case .none: return nil
        }
    }

    /// `getSortValue`: numbers stay numbers, booleans become 1 or 0, text is lowercased and
    /// `null` sorts as the empty string.
    var sortKey: SortKey {
        switch self {
        case .text(let text): return .text(text.lowercased())
        case .number(let number): return .number(number)
        case .bool(let flag): return .number(flag ? 1 : 0)
        case .none: return .text("")
        }
    }

    enum SortKey: Equatable {
        case number(Decimal)
        case text(String)

        var text: String {
            switch self {
            case .number(let number): return VisionFormat.plain(number)
            case .text(let text): return text
            }
        }
    }
}

/// The active sort of a table: a column key and its direction.
public struct LocalTableSort: Equatable, Sendable {
    public let key: String
    public let ascending: Bool

    public init(key: String, ascending: Bool) {
        self.key = key
        self.ascending = ascending
    }
}

/// One column filter, as a chip shows it.
public struct TableColumnFilter: Equatable, Sendable, Identifiable {
    public let key: String
    public let value: String

    public var id: String { key }
}

/// The client-side search, column filters and sort of `VirtualDataTable` (apps/frontend/src/
/// components/shared/VirtualDataTable.tsx) for a table whose rows are all loaded.
public struct LocalTableQuery: Equatable, Sendable {
    /// The search input, as typed.
    public var search = ""
    /// The column filters in the order they were first set (the chips' order).
    public private(set) var filters: [TableColumnFilter] = []
    public private(set) var sort: LocalTableSort?

    public init() {}

    /// `activeFilterCount`: the badge on Clear all.
    public var activeFilterCount: Int { filters.count }

    /// The filter text of a column, `""` when none is set.
    public func filter(for key: String) -> String {
        filters.first { $0.key == key }?.value ?? ""
    }

    /// Clear all shows while a filter, any search text or a sort is set.
    public var showsClearAll: Bool { !filters.isEmpty || !search.isEmpty || sort != nil }

    /// The table is narrowed by search or a filter: an empty result says "no results"
    /// instead of the page's empty state.
    public var isNarrowed: Bool { !search.isEmpty || !filters.isEmpty }

    /// `setColumnFilter`: an empty value removes the filter; a changed one keeps its place.
    public mutating func setFilter(_ key: String, to value: String) {
        if value.isEmpty {
            filters.removeAll { $0.key == key }
        } else if let index = filters.firstIndex(where: { $0.key == key }) {
            filters[index] = TableColumnFilter(key: key, value: value)
        } else {
            filters.append(TableColumnFilter(key: key, value: value))
        }
    }

    /// `handleSort`: a new column sorts ascending, then descending, then not at all.
    public mutating func toggleSort(_ key: String) {
        guard let sort, sort.key == key else {
            self.sort = LocalTableSort(key: key, ascending: true)
            return
        }
        self.sort = sort.ascending ? LocalTableSort(key: key, ascending: false) : nil
    }

    /// `clearAllFilters`: search, column filters and sort.
    public mutating func clearAll() {
        search = ""
        filters = []
        sort = nil
    }

    /// `processedRows`: column filters (case-insensitive substring of the raw value), then
    /// the search across `keys` (when it has more than whitespace), then a stable sort.
    public func apply<Row>(_ rows: [Row], keys: [String], value: (Row, String) -> TableRawValue) -> [Row] {
        var result = Array(rows.enumerated())
        for columnFilter in filters {
            let needle = columnFilter.value.lowercased()
            result = result.filter { pair in
                value(pair.element, columnFilter.key).string?.lowercased().contains(needle) ?? false
            }
        }
        if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let needle = search.lowercased()
            result = result.filter { pair in
                keys.contains { key in value(pair.element, key).string?.lowercased().contains(needle) ?? false }
            }
        }
        if let sort {
            result.sort { left, right in
                let order = Self.compare(value(left.element, sort.key).sortKey, value(right.element, sort.key).sortKey)
                if order == .orderedSame { return left.offset < right.offset }
                return sort.ascending ? order == .orderedAscending : order == .orderedDescending
            }
        }
        return result.map { $0.element }
    }

    /// `openFilterUniqueValues`: the distinct non-blank raw values of a column, in numeric
    /// locale order.
    public static func uniqueValues<Row>(_ rows: [Row], key: String, value: (Row, String) -> TableRawValue)
        -> [String]
    {
        var seen = Set<String>()
        var values: [String] = []
        for row in rows {
            guard let text = value(row, key).string,
                !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !seen.contains(text)
            else { continue }
            seen.insert(text)
            values.append(text)
        }
        let indexed = Array(values.enumerated())
        return indexed.sorted { left, right in
            let order = localeCompare(left.element, right.element)
            if order == .orderedSame { return left.offset < right.offset }
            return order == .orderedAscending
        }
        .map { $0.element }
    }

    /// `ColumnFilter`'s value list: the values containing the value search, case-insensitive.
    public static func matchingValues(_ values: [String], search: String) -> [String] {
        let needle = search.lowercased()
        guard !needle.isEmpty else { return values }
        return values.filter { $0.lowercased().contains(needle) }
    }

    /// Two numbers compare as numbers; anything else as text, like `localeCompare` with
    /// `{ numeric: true }`.
    static func compare(_ left: TableRawValue.SortKey, _ right: TableRawValue.SortKey) -> ComparisonResult {
        if case .number(let a) = left, case .number(let b) = right {
            if a == b { return .orderedSame }
            return a < b ? .orderedAscending : .orderedDescending
        }
        return localeCompare(left.text, right.text)
    }

    static func localeCompare(_ left: String, _ right: String) -> ComparisonResult {
        left.compare(right, options: [.numeric], range: nil, locale: Locale.current)
    }
}
