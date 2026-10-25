import Testing
import VisionNativeCore

@testable import VisionNativeUI

@Suite("Chart axis ticks")
struct ChartAxisTicksTests {
    /// Regression: the Portfolio value chart labelled every day of a multi-year series,
    /// drawing a solid band of grid lines and overlapping date labels.
    @Test func longCategoricalAxisKeepsSixEvenlySpacedTicks() {
        let keys = (0..<1000).map { String(format: "day-%04d", $0) }
        let ticks = ChartAxisTicks.evenlySpaced(keys)
        #expect(ticks.count == 6)
        #expect(ticks.first == "day-0000")
        #expect(ticks.last == "day-0999")
        #expect(ticks == ["day-0000", "day-0200", "day-0400", "day-0599", "day-0799", "day-0999"])
    }

    @Test func shortAxisKeepsEveryKey() {
        #expect(ChartAxisTicks.evenlySpaced(["a", "b", "c"]) == ["a", "b", "c"])
        #expect(ChartAxisTicks.evenlySpaced([String]()) == [])
        #expect(ChartAxisTicks.evenlySpaced(Array("abcdef").map(String.init)) == ["a", "b", "c", "d", "e", "f"])
    }

    /// The web `xTickPattern`: day ticks up to six months, month ticks beyond.
    @Test func portfolioPeriodsPickTheWebTickPattern() {
        #expect(
            PortfolioPeriod.allCases.filter(PortfolioChartTicks.usesDayTicks) == [.oneMonth, .threeMonths, .sixMonths])
    }
}
