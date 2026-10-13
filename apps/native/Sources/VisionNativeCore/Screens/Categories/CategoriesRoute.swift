import Foundation

/// The route of `/categories` (apps/frontend/src/pages/CategoriesPage.tsx): `show_all`
/// (`true` includes inactive categories) and one `expanded` parameter per open branch, both
/// written with replace.
public enum CategoriesRoutes {
    public static let path = "/categories"
    public static let showAllParameter = "show_all"
    public static let expandedParameter = "expanded"

    /// `booleanSearchParamCodec`: only `true` is on.
    public static func showAll(in route: NativeRoute) -> Bool {
        route.value(showAllParameter) == "true"
    }

    /// `searchParams.getAll("expanded").map(Number)`, in URL order without repeats; a value
    /// that is not a whole number matches no node and is left out.
    public static func expanded(in route: NativeRoute) -> [Int] {
        var ids: [Int] = []
        for item in route.query where item.name == expandedParameter {
            guard let text = item.value?.trimmingCharacters(in: .whitespaces), let id = Int(text), !ids.contains(id)
            else { continue }
            ids.append(id)
        }
        return ids
    }

    /// `writeExpanded`: every `expanded` goes, then one per id is appended; the other
    /// parameters stay.
    public static func writingExpanded(_ ids: [Int], to route: NativeRoute) -> [URLQueryItem] {
        route.query.filter { $0.name != expandedParameter }
            + ids.map { URLQueryItem(name: expandedParameter, value: String($0)) }
    }

    /// The name link: `/transactions?category_id=<id>` for a leaf, or
    /// `category_ids=<subtree ids>` for a branch, with `filter_label=<path>`.
    public static func transactionsLink(_ node: OpenAPI.CategoryNode, subtreeIds: [Int]) -> String {
        let filter =
            subtreeIds.count == 1
            ? URLQueryItem(name: "category_id", value: String(node.id))
            : URLQueryItem(name: "category_ids", value: subtreeIds.map(String.init).joined(separator: ","))
        return NativeRoute(
            path: TransactionsRoutes.path,
            query: [filter, URLQueryItem(name: "filter_label", value: CategoryTree.pathLabel(node))]
        ).string
    }
}

/// One visible row of the tree: the node, its depth and its visible children's count.
public struct CategoryTreeRow: Equatable, Sendable, Identifiable {
    public let node: OpenAPI.CategoryNode
    public let level: Int
    /// The visible children (`descendants` of the web's row).
    public let childCount: Int

    public var id: Int { node.id }
    /// A branch has a disclosure chevron and its Delete is disabled.
    public var isBranch: Bool { childCount > 0 }

    public init(node: OpenAPI.CategoryNode, level: Int, childCount: Int) {
        self.node = node
        self.level = level
        self.childCount = childCount
    }
}

/// The tree `CategoriesPage` builds from `GET /api/categories/tree`: the visible nodes (all,
/// or the active ones plus their ancestors for context), siblings by name then id, and the
/// flat list of rows under the expanded branches.
public struct CategoryTree: Sendable {
    /// Every node the server returned, active or not.
    public let all: [OpenAPI.CategoryNode]
    /// The nodes the tree shows.
    public let visible: [OpenAPI.CategoryNode]
    private let children: [Int: [OpenAPI.CategoryNode]]
    /// The roots, sorted.
    public let roots: [OpenAPI.CategoryNode]

    public init(nodes: [OpenAPI.CategoryNode], showAll: Bool, locale: Locale = Locale(identifier: "en")) {
        all = nodes
        if showAll {
            visible = nodes
        } else {
            // Old data may have an inactive ancestor above an active descendant: keep it as
            // context rather than orphaning the child.
            let kept = Set(nodes.filter(\.isActive).flatMap(\.pathIds))
            visible = nodes.filter { kept.contains($0.id) }
        }
        var map: [Int: [OpenAPI.CategoryNode]] = [:]
        var topLevel: [OpenAPI.CategoryNode] = []
        for node in visible {
            if let parent = node.parentId {
                map[parent, default: []].append(node)
            } else {
                topLevel.append(node)
            }
        }
        let order: (OpenAPI.CategoryNode, OpenAPI.CategoryNode) -> Bool = { left, right in
            let byName = left.name.compare(right.name, locale: locale)
            if byName != .orderedSame { return byName == .orderedAscending }
            return left.id < right.id
        }
        children = map.mapValues { $0.sorted(by: order) }
        roots = topLevel.sorted(by: order)
    }

    /// `path.join(" / ")`.
    public static func pathLabel(_ node: OpenAPI.CategoryNode) -> String {
        node.path.joined(separator: " / ")
    }

    /// The visible children of a node, sorted.
    public func children(of id: Int) -> [OpenAPI.CategoryNode] {
        children[id] ?? []
    }

    /// The visible nodes with children (Expand all's ids, in visible order).
    public var branchIds: [Int] {
        visible.filter { !(children[$0.id] ?? []).isEmpty }.map(\.id)
    }

    /// Every branch is open (the View menu then offers Collapse all).
    public func allExpanded(_ expanded: Set<Int>) -> Bool {
        let branches = branchIds
        return !branches.isEmpty && branches.allSatisfy { expanded.contains($0) }
    }

    /// The rows in rendered order: each root, and the children of every expanded node.
    public func rows(expanded: Set<Int>) -> [CategoryTreeRow] {
        var result: [CategoryTreeRow] = []
        func walk(_ node: OpenAPI.CategoryNode, _ level: Int) {
            let kids = children(of: node.id)
            result.append(CategoryTreeRow(node: node, level: level, childCount: kids.count))
            guard expanded.contains(node.id) else { return }
            for child in kids { walk(child, level + 1) }
        }
        for root in roots { walk(root, 0) }
        return result
    }

    /// The branch badge: the visible nodes in the subtree, the node included.
    public func subtreeCount(_ id: Int) -> Int {
        visible.filter { $0.pathIds.contains(id) }.count
    }

    /// The node and every descendant, active or not (the transactions link's ids).
    public func subtreeIds(_ id: Int) -> [Int] {
        all.filter { $0.pathIds.contains(id) }.map(\.id)
    }

    /// Merge targets: active nodes outside the source's subtree.
    public func mergeTargets(_ source: OpenAPI.CategoryNode) -> [OpenAPI.CategoryNode] {
        all.filter { $0.isActive && $0.id != source.id && !$0.pathIds.contains(source.id) }
    }

    /// Merge category is enabled while a target exists.
    public func canMerge(_ node: OpenAPI.CategoryNode) -> Bool {
        !mergeTargets(node).isEmpty
    }

    /// The Parent select: active nodes, without the edited node and its descendants.
    public func parentOptions(editing node: OpenAPI.CategoryNode?) -> [OpenAPI.CategoryNode] {
        all.filter { candidate in
            candidate.isActive && (node.map { !candidate.pathIds.contains($0.id) } ?? true)
        }
    }

    /// A node by id among every node.
    public func node(_ id: Int) -> OpenAPI.CategoryNode? {
        all.first { $0.id == id }
    }
}
