import SwiftUI
import Testing
import VisionNativeCore

@testable import VisionNativeUI

@MainActor
@Suite("Statistics flow pointer targeting")
struct StatisticsFlowHitTests {
    @Test func nodesAndBandsRemainTargetableAndOutsideSpaceIsEmpty() throws {
        let json = #"{"nodes":[{"id":"income","label":"Income","value":100},{"id":"spending","label":"Spending","value":100}],"links":[{"source":"income","target":"spending","value":100}],"year":2026}"#
        let flow = try JSONDecoder().decode(StatisticsFlow.self, from: Data(json.utf8))
        let layout = StatisticsFlowLayout(flow: flow, width: 640, height: 380)
        let margin = CGFloat(StatisticsFlowLayout.margin)
        let node = try #require(layout.nodes.first)
        let nodeHit = StatisticsFlowView.hit(
            at: CGPoint(x: margin + (node.x0 + node.x1) / 2, y: margin + (node.y0 + node.y1) / 2),
            layout: layout, margin: margin)
        #expect(nodeHit.node == node.id)
        #expect(nodeHit.link == nil)
        let link = try #require(layout.links.first)
        let bandHit = StatisticsFlowView.hit(
            at: CGPoint(x: margin + (link.sourceX + link.targetX) / 2,
                        y: margin + (link.sourceY + link.targetY) / 2),
            layout: layout, margin: margin)
        #expect(bandHit.node == nil)
        #expect(bandHit.link == link.id)
        let outside = StatisticsFlowView.hit(at: CGPoint(x: -10, y: -10), layout: layout, margin: margin)
        #expect(outside.node == nil && outside.link == nil)
    }
}
