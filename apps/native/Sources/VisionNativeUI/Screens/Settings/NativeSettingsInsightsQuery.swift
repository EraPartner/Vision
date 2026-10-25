import Foundation
import VisionNativeCore

/// Display filtering only. Group commands operate on the currently displayed
/// categories, while all unrelated and unknown exclusion IDs remain intact.
enum NativeSettingsInsightsQuery {
    struct CategoryGroup: Identifiable, Equatable {
        let name: String
        let items: [OpenAPI.CategoryNode]
        var id: String { name }
    }
    enum CheckState: Equatable { case off, mixed, on }

    static func groups(_ categories: [OpenAPI.CategoryNode], search: String, locale: Locale = .current)
        -> [CategoryGroup]
    {
        let query = search.lowercased()
        var grouped: [String: [OpenAPI.CategoryNode]] = [:]
        for category in categories {
            guard search.isEmpty || category.path.contains(where: { $0.lowercased().contains(query) }) else { continue }
            grouped[category.path.first ?? category.name, default: []].append(category)
        }
        return grouped.keys.sorted { compare($0, $1, locale: locale) }.map { key in
            let items = grouped[key, default: []].enumerated().sorted { left, right in
                let result = left.element.path.joined(separator: " / ").compare(
                    right.element.path.joined(separator: " / "), options: [], locale: locale)
                return result == .orderedSame ? left.offset < right.offset : result == .orderedAscending
            }.map(\.element)
            return CategoryGroup(name: key, items: items)
        }
    }
    static func checkState(_ items: [OpenAPI.CategoryNode], excluded: [CategoryID]) -> CheckState {
        let all = items.allSatisfy { excluded.contains($0.id) }
        if all { return .on }
        return items.contains { excluded.contains($0.id) } ? .mixed : .off
    }
    static func toggledGroup(_ items: [OpenAPI.CategoryNode], excluded: [CategoryID]) -> [CategoryID] {
        if items.allSatisfy({ excluded.contains($0.id) }) {
            return excluded.filter { id in !items.contains { $0.id == id } }
        }
        return excluded + items.map(\.id).filter { !excluded.contains($0) }
    }
    static func toggledID<ID: Equatable>(_ id: ID, excluded: [ID]) -> [ID] {
        excluded.contains(id) ? excluded.filter { $0 != id } : excluded + [id]
    }
    static func recipients(_ source: [OpenAPI.Recipient], search: String, excluded: [RecipientID], locale: Locale = .current)
        -> [OpenAPI.Recipient]
    {
        let query = search.lowercased()
        return source.prefix(1000).enumerated().filter { query.isEmpty || $0.element.name.lowercased().contains(query) }
            .sorted { left, right in
                let leftExcluded = excluded.contains(left.element.id)
                let rightExcluded = excluded.contains(right.element.id)
                if leftExcluded != rightExcluded { return leftExcluded }
                let result = left.element.name.compare(right.element.name, options: [], locale: locale)
                return result == .orderedSame ? left.offset < right.offset : result == .orderedAscending
            }.map(\.element)
    }
    private static func compare(_ left: String, _ right: String, locale: Locale) -> Bool {
        left.compare(right, options: [], locale: locale) == .orderedAscending
    }
}
