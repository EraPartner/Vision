import Foundation

/// One laid-out Sankey node in points, inside the plot area (the caller adds `margin`).
/// Flow values and totals stay Decimal.
public struct StatisticsFlowNodeLayout: Equatable, Sendable, Identifiable {
    public let node: StatisticsFlow.Node
    /// The node's amount as the web chart shows it on hover: the larger of its in and out totals.
    public let value: Decimal
    public let column: Int
    public let x0: Double
    public let x1: Double
    public let y0: Double
    public let y1: Double
    /// Right half of the plot: its label sits on the node's left, end-anchored.
    public let labelsLeading: Bool
    public var id: String { node.id }
    public var midY: Double { y0 + max(1, y1 - y0) / 2 }
}

public struct StatisticsFlowLinkLayout: Equatable, Sendable, Identifiable {
    public let link: StatisticsFlow.Link
    /// Link thickness in points before the 1 pt drawing minimum.
    public let width: Double
    public let sourceX: Double
    public let targetX: Double
    public let sourceY: Double
    public let targetY: Double
    public var id: String { link.id }
}

/// The Statistics flow layout. Same algorithm and constants as the web `SankeyChart` (ADR-245):
/// 16 pt margins, 16 pt nodes, 18 pt padding, d3-sankey positions via `SankeyLayout`.
public struct StatisticsFlowLayout: Equatable, Sendable {
    public static let margin = 16.0
    public static let nodeWidth = 16.0
    public static let nodePadding = 18.0

    public let nodes: [StatisticsFlowNodeLayout]
    public let links: [StatisticsFlowLinkLayout]
    public let columnCount: Int

    /// `width` and `height` are the full chart size. Like the web chart, a graph without links, a
    /// width under 2 pt or a layout d3-sankey rejects (unknown id, cycle) lays out nothing.
    public init(flow: StatisticsFlow, width: Double, height: Double) {
        let innerWidth = width - 2 * Self.margin
        let innerHeight = height - 2 * Self.margin
        guard !flow.nodes.isEmpty, !flow.links.isEmpty, width >= 2,
            let result = try? SankeyLayout.layout(
                nodeIDs: flow.nodes.map(\.id),
                links: flow.links.map {
                    SankeyLayout.InputLink(
                        source: $0.source, target: $0.target, value: NSDecimalNumber(decimal: $0.value).doubleValue)
                },
                options: SankeyLayout.Options(
                    nodeWidth: Self.nodeWidth, nodePadding: Self.nodePadding, x0: 0, y0: 0, x1: innerWidth,
                    y1: innerHeight))
        else {
            nodes = []
            links = []
            columnCount = 0
            return
        }
        func total(_ links: [StatisticsFlow.Link], _ matches: (StatisticsFlow.Link) -> Bool) -> Decimal {
            links.filter(matches).reduce(0) { $0 + $1.value }
        }
        nodes = zip(flow.nodes, result.nodes).map { node, laid in
            StatisticsFlowNodeLayout(
                node: node,
                value: max(
                    total(flow.links) { $0.source == node.id }, total(flow.links) { $0.target == node.id }),
                column: laid.layer, x0: laid.x0, x1: laid.x1, y0: laid.y0, y1: laid.y1,
                labelsLeading: laid.x0 > innerWidth / 2)
        }
        links = zip(flow.links, result.links).map { link, laid in
            StatisticsFlowLinkLayout(
                link: link, width: laid.width, sourceX: result.nodes[laid.source].x1,
                targetX: result.nodes[laid.target].x0, sourceY: laid.y0, targetY: laid.y1)
        }
        columnCount = (result.nodes.map(\.layer).max() ?? 0) + 1
    }
}
