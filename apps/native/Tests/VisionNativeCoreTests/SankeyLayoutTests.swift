import Foundation
import Testing

@testable import VisionNativeCore

/// Ports of `sankeyLayout.test.ts`. Expected values are d3-sankey 0.12.3's output for the same
/// graph, recorded before the web app dropped the package (ADR-245).
@Suite("Sankey layout parity")
struct SankeyLayoutTests {
    private let ids = ["salary", "__income__", "__spending__", "__savings__", "rent", "food"]
    private let links = [
        SankeyLayout.InputLink(source: "salary", target: "__income__", value: 3000),
        SankeyLayout.InputLink(source: "__income__", target: "__spending__", value: 2200),
        SankeyLayout.InputLink(source: "__income__", target: "__savings__", value: 800),
        SankeyLayout.InputLink(source: "__spending__", target: "rent", value: 1500),
        SankeyLayout.InputLink(source: "__spending__", target: "food", value: 700),
    ]
    private let options = SankeyLayout.Options(
        nodeWidth: 16, nodePadding: 18, x0: 0, y0: 0, x1: 600, y1: 300)

    private func close(_ actual: Double, _ expected: Double) -> Bool { abs(actual - expected) < 1e-9 }

    @Test func matchesD3SankeyNodePositionsAndLinkGeometry() throws {
        let graph = try SankeyLayout.layout(nodeIDs: ids, links: links, options: options)
        let nodes: [(String, Double, Double, Double, Double, Double)] = [
            ("salary", 0, 16, 11.469889948382939, 275.46988994838296, 3000),
            ("__income__", 194.66666666666666, 210.66666666666666, 11.473468674159562, 275.4734686741595, 3000),
            ("__spending__", 389.3333333333333, 405.3333333333333, 90.89863826126015, 284.4986382612603, 2200),
            ("__savings__", 584, 600, 0, 70.39999999999999, 800),
            ("rent", 584, 600, 88.39999999999999, 220.39999999999998, 1500),
            ("food", 584, 600, 238.39999999999998, 300, 700),
        ]
        #expect(graph.nodes.map(\.id) == nodes.map(\.0))
        for (laid, expected) in zip(graph.nodes, nodes) {
            #expect(close(laid.x0, expected.1) && close(laid.x1, expected.2))
            #expect(close(laid.y0, expected.3) && close(laid.y1, expected.4))
            #expect(close(laid.value, expected.5))
        }
        // The expected link paths start at the source's right edge and end at the target's left
        // edge: M sx,y0 C mx,y0 mx,y1 tx,y1.
        let linkRows: [(Double, Double, Double)] = [
            (143.46988994838293, 143.47346867415956, 264),
            (178.67346867415955, 187.69863826126016, 193.6),
            (46.67346867415956, 35.199999999999996, 70.39999999999999),
            (156.89863826126015, 154.39999999999998, 132),
            (253.69863826126016, 269.2, 61.599999999999994),
        ]
        #expect(graph.links.count == linkRows.count)
        for (laid, expected) in zip(graph.links, linkRows) {
            #expect(close(laid.y0, expected.0) && close(laid.y1, expected.1) && close(laid.width, expected.2))
        }
        #expect(close(graph.nodes[graph.links[0].source].x1, 16))
        #expect(close(graph.nodes[graph.links[0].target].x0, 194.66666666666666))
        #expect(close(graph.nodes[graph.links[2].target].x0, 584))
    }

    @Test func rejectsMissingNodesAndCyclesLikeD3Sankey() {
        #expect(throws: SankeyLayout.LayoutError.missingNode("nope")) {
            try SankeyLayout.layout(
                nodeIDs: ids, links: [SankeyLayout.InputLink(source: "salary", target: "nope", value: 1)],
                options: options)
        }
        #expect(throws: SankeyLayout.LayoutError.circularLink) {
            try SankeyLayout.layout(
                nodeIDs: ["a", "b"],
                links: [
                    SankeyLayout.InputLink(source: "a", target: "b", value: 1),
                    SankeyLayout.InputLink(source: "b", target: "a", value: 1),
                ], options: options)
        }
    }

    @Test func layoutIsDeterministicForRepeatedCalls() throws {
        let first = try SankeyLayout.layout(nodeIDs: ids, links: links, options: options)
        let second = try SankeyLayout.layout(nodeIDs: ids, links: links, options: options)
        #expect(first == second)
    }
}
