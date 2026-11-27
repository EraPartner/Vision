import CoreGraphics
import Testing
import VisionNativeCore

@testable import VisionNativeUI

/// The 2026-11-22 Swift vs React audit's chart pass (findings 3, 11, 13, 14).
@MainActor
@Suite("Chart pass behaviour parity")
struct ChartPassParityTests {
    /// Finding 11: with nothing highlighted, Right starts at the first item and Left at the last.
    @Test func keyboardEntryStartsAtTheFirstOrLastItem() {
        #expect(ChartKeyboard.step(from: nil, forward: true, count: 5) == 0)
        #expect(ChartKeyboard.step(from: nil, forward: false, count: 5) == 4)
        #expect(ChartKeyboard.step(from: 4, forward: true, count: 5) == 4)
        #expect(ChartKeyboard.step(from: 0, forward: false, count: 5) == 0)
        #expect(ChartKeyboard.step(from: 2, forward: true, count: 5) == 3)
    }

    /// Findings 13 and 14: plain charts (volume strip, Home donut) step with the same keys.
    @Test func plainChartKeysFollowTheSameRule() {
        #expect(ChartKeyboard.index(for: .right, from: nil, count: 3) == 0)
        #expect(ChartKeyboard.index(for: .left, from: nil, count: 3) == 2)
        #expect(ChartKeyboard.index(for: .home, from: 2, count: 3) == 0)
        #expect(ChartKeyboard.index(for: .end, from: 0, count: 3) == 2)
        #expect(ChartKeyboard.index(for: .right, from: nil, count: 0) == nil)
    }

    /// Finding 3: near the top of the visible area the tooltip drops below its anchor, and a tall
    /// tooltip stays inside the visible area at every edge.
    @Test func tooltipStaysInsideTheVisibleArea() {
        let size = CGSize(width: 160, height: 80)
        // The chart's top is 20 pt below the scroll view's visible top.
        let visible = ChartHoverTooltip.visibleArea(
            bounds: CGSize(width: 600, height: 300), scrollVisible: CGRect(x: 0, y: -20, width: 600, height: 700))
        let below = ChartHoverTooltip.origin(anchor: CGPoint(x: 300, y: 30), size: size, visible: visible)
        #expect(below.y == CGFloat(30 + 12))
        let tall = CGSize(width: 160, height: 900)
        let pinned = ChartHoverTooltip.origin(anchor: CGPoint(x: 300, y: 200), size: tall, visible: visible)
        #expect(pinned.y >= visible.minY)
        let right = ChartHoverTooltip.origin(anchor: CGPoint(x: 590, y: 200), size: size, visible: visible)
        #expect(right.x + size.width <= visible.maxX)
        // With room above, it stays centred above the anchor.
        let above = ChartHoverTooltip.origin(anchor: CGPoint(x: 300, y: 200), size: size, visible: visible)
        #expect(above == CGPoint(x: 220, y: 200 - 80 - 12))
    }
}
