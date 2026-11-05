import Foundation

/// Sankey layout, a port of the web app's `sankeyLayout.ts` (ADR-245), itself a port of
/// d3-sankey 0.12.3's `sankey()` with `justify` alignment, default node and link order and six
/// relaxation iterations. The arithmetic and the order of operations follow the original so the
/// node order, positions and link widths match the web chart.
///
/// d3-sankey: Copyright 2015, Mike Bostock. All rights reserved. Used under its BSD 3-clause
/// licence; see the notice in `apps/frontend/src/features/statistics/sankeyLayout.ts`.
public enum SankeyLayout {
    public struct Options: Equatable, Sendable {
        public var nodeWidth: Double
        public var nodePadding: Double
        public var x0: Double
        public var y0: Double
        public var x1: Double
        public var y1: Double
        public init(nodeWidth: Double, nodePadding: Double, x0: Double, y0: Double, x1: Double, y1: Double) {
            self.nodeWidth = nodeWidth
            self.nodePadding = nodePadding
            self.x0 = x0
            self.y0 = y0
            self.x1 = x1
            self.y1 = y1
        }
    }

    public struct InputLink: Equatable, Sendable {
        public let source: String
        public let target: String
        public let value: Double
        public init(source: String, target: String, value: Double) {
            self.source = source
            self.target = target
            self.value = value
        }
    }

    public struct Node: Equatable, Sendable {
        public let id: String
        public let index: Int
        public let value: Double
        public let depth: Int
        public let height: Int
        public let layer: Int
        public let x0: Double
        public let x1: Double
        public let y0: Double
        public let y1: Double
    }

    public struct Link: Equatable, Sendable {
        public let index: Int
        /// Index into `Result.nodes`.
        public let source: Int
        public let target: Int
        public let value: Double
        public let width: Double
        public let y0: Double
        public let y1: Double
    }

    public struct Result: Equatable, Sendable {
        public let nodes: [Node]
        public let links: [Link]
    }

    /// d3-sankey throws for these; the web chart then draws nothing.
    public enum LayoutError: Error, Equatable, Sendable {
        case missingNode(String)
        case circularLink
    }

    private static let iterations = 6

    private final class WorkNode {
        let id: String
        let index: Int
        var value = 0.0
        var depth = 0
        var height = 0
        var layer = 0
        var x0 = 0.0
        var x1 = 0.0
        var y0 = 0.0
        var y1 = 0.0
        var sourceLinks: [WorkLink] = []
        var targetLinks: [WorkLink] = []
        init(id: String, index: Int) {
            self.id = id
            self.index = index
        }
    }

    private final class WorkLink {
        let index: Int
        let source: WorkNode
        let target: WorkNode
        let value: Double
        var width = 0.0
        var y0 = 0.0
        var y1 = 0.0
        init(index: Int, source: WorkNode, target: WorkNode, value: Double) {
            self.index = index
            self.source = source
            self.target = target
            self.value = value
        }
    }

    /// `Array.prototype.sort` is stable; insertion sort keeps that guarantee without relying on
    /// the standard library's unspecified stability. Columns hold a handful of nodes.
    private static func stableSort<T>(_ items: inout [T], by compare: (T, T) -> Double) {
        guard items.count > 1 else { return }
        for i in 1..<items.count {
            let current = items[i]
            var j = i - 1
            while j >= 0 && compare(items[j], current) > 0 {
                items[j + 1] = items[j]
                j -= 1
            }
            items[j + 1] = current
        }
    }

    /// `order || a.index - b.index`, as d3-sankey writes it (0 and NaN tie).
    private static func byIndexWhenTied(_ order: Double, _ a: Int, _ b: Int) -> Double {
        order == 0 || order.isNaN ? Double(a - b) : order
    }
    private static func ascendingBreadth(_ a: WorkNode, _ b: WorkNode) -> Double { a.y0 - b.y0 }
    private static func ascendingSourceBreadth(_ a: WorkLink, _ b: WorkLink) -> Double {
        byIndexWhenTied(ascendingBreadth(a.source, b.source), a.index, b.index)
    }
    private static func ascendingTargetBreadth(_ a: WorkLink, _ b: WorkLink) -> Double {
        byIndexWhenTied(ascendingBreadth(a.target, b.target), a.index, b.index)
    }

    /// d3-array's `min` and `max` skip NaN; an empty or all-NaN input gives NaN here.
    private static func d3Min(_ values: [Double]) -> Double {
        values.filter { !$0.isNaN }.min() ?? .nan
    }
    private static func d3Max(_ values: [Double]) -> Double {
        values.filter { !$0.isNaN }.max() ?? .nan
    }
    private static func d3Sum(_ values: [Double]) -> Double {
        var total = 0.0
        for value in values where !value.isNaN { total += value }
        return total
    }

    /// Lays out nodes (in input order) and links (in input order). Throws on a link to an unknown
    /// id or on a cycle, like d3-sankey.
    public static func layout(nodeIDs: [String], links inputLinks: [InputLink], options: Options) throws -> Result {
        let x0 = options.x0
        let y0 = options.y0
        let x1 = options.x1
        let y1 = options.y1
        let dx = options.nodeWidth
        let dy = options.nodePadding
        guard !nodeIDs.isEmpty else { return Result(nodes: [], links: []) }

        // computeNodeLinks
        let nodes = nodeIDs.enumerated().map { WorkNode(id: $1, index: $0) }
        var nodeByID: [String: WorkNode] = [:]
        for node in nodes { nodeByID[node.id] = node }
        func find(_ id: String) throws -> WorkNode {
            guard let node = nodeByID[id] else { throw LayoutError.missingNode(id) }
            return node
        }
        var links: [WorkLink] = []
        for (index, input) in inputLinks.enumerated() {
            let link = WorkLink(
                index: index, source: try find(input.source), target: try find(input.target), value: input.value)
            link.source.sourceLinks.append(link)
            link.target.targetLinks.append(link)
            links.append(link)
        }

        // computeNodeValues
        for node in nodes {
            node.value = max(d3Sum(node.sourceLinks.map(\.value)), d3Sum(node.targetLinks.map(\.value)))
        }

        // computeNodeDepths / computeNodeHeights
        func walk(assign: (WorkNode, Int) -> Void, next: (WorkNode) -> [WorkNode]) throws {
            var current = nodes
            var x = 0
            while !current.isEmpty {
                var following: [WorkNode] = []
                var seen = Set<ObjectIdentifier>()
                for node in current {
                    assign(node, x)
                    for other in next(node) where seen.insert(ObjectIdentifier(other)).inserted {
                        following.append(other)
                    }
                }
                x += 1
                if x > nodes.count { throw LayoutError.circularLink }
                current = following
            }
        }
        try walk(assign: { node, x in node.depth = x }, next: { node in node.sourceLinks.map(\.target) })
        try walk(assign: { node, x in node.height = x }, next: { node in node.targetLinks.map(\.source) })

        // computeNodeLayers (justify alignment)
        let layerCount = (nodes.map(\.depth).max() ?? 0) + 1
        let kx = (x1 - x0 - dx) / Double(layerCount - 1)
        var columns = [[WorkNode]](repeating: [], count: layerCount)
        for node in nodes {
            let aligned = node.sourceLinks.isEmpty ? layerCount - 1 : node.depth
            let i = max(0, min(layerCount - 1, aligned))
            node.layer = i
            node.x0 = x0 + Double(i) * kx
            node.x1 = node.x0 + dx
            columns[i].append(node)
        }

        func reorderLinks(_ column: [WorkNode]) {
            for node in column {
                stableSort(&node.sourceLinks, by: ascendingTargetBreadth)
                stableSort(&node.targetLinks, by: ascendingSourceBreadth)
            }
        }
        func reorderNodeLinks(_ node: WorkNode) {
            for link in node.targetLinks { stableSort(&link.source.sourceLinks, by: ascendingTargetBreadth) }
            for link in node.sourceLinks { stableSort(&link.target.targetLinks, by: ascendingSourceBreadth) }
        }

        // computeNodeBreadths
        let py = min(dy, (y1 - y0) / (d3Max(columns.map { Double($0.count) }) - 1))
        let ky = d3Min(
            columns.map { column in
                (y1 - y0 - Double(column.count - 1) * py) / d3Sum(column.map(\.value))
            })
        for column in columns {
            var y = y0
            for node in column {
                node.y0 = y
                node.y1 = y + node.value * ky
                y = node.y1 + py
                for link in node.sourceLinks { link.width = link.value * ky }
            }
            y = (y1 - y + py) / Double(column.count + 1)
            for (i, node) in column.enumerated() {
                node.y0 += y * Double(i + 1)
                node.y1 += y * Double(i + 1)
            }
            reorderLinks(column)
        }

        func targetTop(_ source: WorkNode, _ target: WorkNode) -> Double {
            var y = source.y0 - Double(source.sourceLinks.count - 1) * py / 2
            for link in source.sourceLinks {
                if link.target === target { break }
                y += link.width + py
            }
            for link in target.targetLinks {
                if link.source === source { break }
                y -= link.width
            }
            return y
        }
        func sourceTop(_ source: WorkNode, _ target: WorkNode) -> Double {
            var y = target.y0 - Double(target.targetLinks.count - 1) * py / 2
            for link in target.targetLinks {
                if link.source === source { break }
                y += link.width + py
            }
            for link in source.sourceLinks {
                if link.target === target { break }
                y -= link.width
            }
            return y
        }

        func collideDown(_ column: [WorkNode], start: Double, from: Int, alpha: Double) {
            var y = start
            guard from < column.count else { return }
            for i in from..<column.count {
                let node = column[i]
                let shift = (y - node.y0) * alpha
                if shift > 1e-6 {
                    node.y0 += shift
                    node.y1 += shift
                }
                y = node.y1 + py
            }
        }
        func collideUp(_ column: [WorkNode], start: Double, from: Int, alpha: Double) {
            var y = start
            var i = from
            while i >= 0 {
                let node = column[i]
                let shift = (node.y1 - y) * alpha
                if shift > 1e-6 {
                    node.y0 -= shift
                    node.y1 -= shift
                }
                y = node.y0 - py
                i -= 1
            }
        }
        func resolveCollisions(_ column: [WorkNode], alpha: Double) {
            let i = column.count >> 1
            let subject = column[i]
            collideUp(column, start: subject.y0 - py, from: i - 1, alpha: alpha)
            collideDown(column, start: subject.y1 + py, from: i + 1, alpha: alpha)
            collideUp(column, start: y1, from: column.count - 1, alpha: alpha)
            collideDown(column, start: y0, from: 0, alpha: alpha)
        }

        for iteration in 0..<iterations {
            let alpha = pow(0.99, Double(iteration))
            let beta = max(1 - alpha, Double(iteration + 1) / Double(iterations))
            // relaxRightToLeft
            var right = columns.count - 2
            while right >= 0 {
                for source in columns[right] {
                    var y = 0.0
                    var w = 0.0
                    for link in source.sourceLinks {
                        let v = link.value * Double(link.target.layer - source.layer)
                        y += sourceTop(source, link.target) * v
                        w += v
                    }
                    if !(w > 0) { continue }
                    let shift = (y / w - source.y0) * alpha
                    source.y0 += shift
                    source.y1 += shift
                    reorderNodeLinks(source)
                }
                stableSort(&columns[right], by: ascendingBreadth)
                resolveCollisions(columns[right], alpha: beta)
                right -= 1
            }
            // relaxLeftToRight
            if columns.count > 1 {
                for column in 1..<columns.count {
                    for target in columns[column] {
                        var y = 0.0
                        var w = 0.0
                        for link in target.targetLinks {
                            let v = link.value * Double(target.layer - link.source.layer)
                            y += targetTop(link.source, target) * v
                            w += v
                        }
                        if !(w > 0) { continue }
                        let shift = (y / w - target.y0) * alpha
                        target.y0 += shift
                        target.y1 += shift
                        reorderNodeLinks(target)
                    }
                    stableSort(&columns[column], by: ascendingBreadth)
                    resolveCollisions(columns[column], alpha: beta)
                }
            }
        }

        // computeLinkBreadths
        for node in nodes {
            var top = node.y0
            var bottom = top
            for link in node.sourceLinks {
                link.y0 = top + link.width / 2
                top += link.width
            }
            for link in node.targetLinks {
                link.y1 = bottom + link.width / 2
                bottom += link.width
            }
        }

        return Result(
            nodes: nodes.map {
                Node(
                    id: $0.id, index: $0.index, value: $0.value, depth: $0.depth, height: $0.height,
                    layer: $0.layer, x0: $0.x0, x1: $0.x1, y0: $0.y0, y1: $0.y1)
            },
            links: links.map {
                Link(
                    index: $0.index, source: $0.source.index, target: $0.target.index, value: $0.value,
                    width: $0.width, y0: $0.y0, y1: $0.y1)
            })
    }
}
