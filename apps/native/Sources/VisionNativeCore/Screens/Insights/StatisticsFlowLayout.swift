import Foundation

/// Normalized drawing coordinates only. The flow values and totals stay Decimal.
public struct StatisticsFlowNodeLayout: Equatable, Sendable, Identifiable {
    public let node: StatisticsFlow.Node
    public let column: Int
    public let x: Double
    public let y: Double
    public let height: Double
    public var id: String { node.id }
}

public struct StatisticsFlowLayout: Equatable, Sendable {
    public let nodes: [StatisticsFlowNodeLayout]
    public let links: [StatisticsFlow.Link]
    public let columnCount: Int
    public init(flow: StatisticsFlow) {
        let ids = Set(flow.nodes.map(\.id))
        let links = flow.links.filter { ids.contains($0.source) && ids.contains($0.target) && $0.value > 0 }
        var levels = Dictionary(uniqueKeysWithValues: flow.nodes.map { ($0.id, 0) })
        for _ in 0..<flow.nodes.count {
            var changed = false
            for link in links {
                let next = min(flow.nodes.count - 1, (levels[link.source] ?? 0) + 1)
                if next > levels[link.target, default: 0] {
                    levels[link.target] = next
                    changed = true
                }
            }
            if !changed { break }
        }
        columnCount = (levels.values.max() ?? 0) + 1
        var result: [StatisticsFlowNodeLayout] = []
        for column in 0..<columnCount {
            let group = flow.nodes.filter { levels[$0.id] == column }
            let total = max(group.reduce(0) { $0 + max(0, $1.value) }, 1)
            let gap = min(0.025, 0.2 / Double(max(1, group.count)))
            let minimum = min(0.04, 0.4 / Double(max(1, group.count)))
            let available = max(0, 1 - gap * Double(max(0, group.count - 1)) - minimum * Double(group.count))
            var y = 0.0
            for node in group {
                let height = minimum + available * NSDecimalNumber(decimal: max(0, node.value) / total).doubleValue
                result.append(
                    StatisticsFlowNodeLayout(
                        node: node, column: column,
                        x: Double(column) / Double(max(1, columnCount - 1)), y: y, height: height))
                y += height + gap
            }
        }
        nodes = result
        self.links = links
    }
}
