import Testing

@testable import VisionNativeUI

@Suite("Responsive columns")
struct ResponsiveColumnsTests {
    /// The native grids reuse the Tailwind breakpoints the React pages use (`lg:grid-cols-*`).
    @Test func breakpointsMatchTailwind() {
        #expect(VisionBreakpoint.sm == 640)
        #expect(VisionBreakpoint.md == 768)
        #expect(VisionBreakpoint.lg == 1024)
        #expect(VisionBreakpoint.xl == 1280)
    }

    /// The portfolio grids collapse to one column below `lg` and split 2/3 + 1/3 above it.
    @Test func portfolioGridsUseTheLargeBreakpoint() {
        let holdingsAndAllocation = VisionResponsiveColumns(weights: [2, 1])
        #expect(holdingsAndAllocation.minimumPageWidth == VisionBreakpoint.lg)
        #expect(holdingsAndAllocation.weights.reduce(0, +) == 3)
        #expect(VisionResponsiveColumns(weights: [1, 1]).weights.count == 2)
    }
}
