import SwiftUI
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
    /// The Net balance trend runs 1k to 3k on the web: a padded, niced fit, not a zero baseline.
    @Test func fittedDomainPadsAndNicesInsteadOfStartingAtZero() {
        let domain = ChartAxisTicks.fittedDomain([1_000, 2_000, 3_000])
        #expect(domain == 800...3_200)
        #expect(ChartAxisTicks.ticks(domain.lowerBound, domain.upperBound, count: 5) == [1_000, 1_500, 2_000, 2_500, 3_000])
    }

    @Test func zeroBasedDomainKeepsTheBaselineAndPadsOnlyTheTop() {
        let domain = ChartAxisTicks.zeroBasedDomain([1_200, 6_100])
        #expect(domain.lowerBound == 0)
        #expect(domain.upperBound >= 6_100 * 1.08)
        #expect(ChartAxisTicks.zeroBasedDomain([-500, 2_000]).lowerBound <= -500)
    }

    @Test func flatAndEmptySeriesStillGetADomain() {
        let flat = ChartAxisTicks.fittedDomain([5, 5])
        #expect(flat.lowerBound < 5 && flat.upperBound > 5)
        #expect(ChartAxisTicks.fittedDomain([]).upperBound >= 1)
        #expect(ChartAxisTicks.ticks(0, 0, count: 5) == [0])
    }

    @Test func subUnitRangesTickInFractions() {
        #expect(ChartAxisTicks.ticks(0, 1, count: 5) == [0, 0.2, 0.4, 0.6, 0.8, 1])
    }

    /// The cash flow forecast labels day numbers 2, 4, ... 30 on the web, not ISO dates.
    @Test func dayOfMonthAxisLabelsEveryOtherDay() {
        let days = Array(1...30)
        let positions = ChartAxisTicks.dayOfMonthPositions(days, count: 10)
        #expect(positions.map { $0.map { days[$0] } } == Array(stride(from: 2, through: 30, by: 2)))
        #expect(ChartAxisTicks.dayOfMonthPositions([28, 29, 30, 1, 2], count: 10) == nil)
    }

    @Test func monotoneCurveHasFlatTangentsAtExtremaAndFollowsStraightLines() {
        let peak = ChartCurve.tangents([CGPoint(x: 0, y: 0), CGPoint(x: 1, y: 2), CGPoint(x: 2, y: 0)])
        #expect(peak[1] == 0)
        let line = ChartCurve.tangents([CGPoint(x: 0, y: 0), CGPoint(x: 1, y: 1), CGPoint(x: 2, y: 2)])
        #expect(line.allSatisfy { abs($0 - 1) < 1e-9 })
    }
}
