import Foundation
import Testing

@testable import VisionNativeCore

/// Mirrors apps/frontend/src/components/charts/__tests__/chartAria.test.ts.
@Suite struct ChartAccessibilityTests {
    private let strings = DictionaryStrings(
        language: .en,
        table: [
            "chart.aria.kind.pie": "Pie chart", "chart.aria.kind.donut": "Donut chart",
            "chart.aria.kind.bar": "Bar chart", "chart.aria.kind.line": "Line chart",
            "chart.aria.seriesOne": "{kind} with {count} category",
            "chart.aria.seriesOther": "{kind} with {count} categories",
            "chart.aria.series": ", series: {names}",
            "chart.aria.segmentOne": "{kind} with {count} segment",
            "chart.aria.segmentOther": "{kind} with {count} segments",
            "chart.aria.segmentNames": ": {names}", "chart.aria.andMore": ", and {count} more",
            "chart.aria.sparklineEmpty": "Sparkline, no data",
            "chart.aria.sparklineOne": "Sparkline of {count} point, ranging {min} to {max}",
            "chart.aria.sparklineOther": "Sparkline of {count} points, ranging {min} to {max}",
        ])

    @Test func seriesListsCategoryCountAndNamedSeries() {
        #expect(
            ChartAccessibility.series(strings, kind: .bar, categoryCount: 3, seriesLabels: ["Taxes", "Fees"])
                == "Bar chart with 3 categories, series: Taxes, Fees")
        #expect(
            ChartAccessibility.series(strings, kind: .line, categoryCount: 1, seriesLabels: [nil, ""])
                == "Line chart with 1 category")
    }

    @Test func proportionListsSixSegmentsAndTheRemainder() {
        #expect(
            ChartAccessibility.proportion(strings, kind: .pie, names: ["Food", "Rent"])
                == "Pie chart with 2 segments: Food, Rent")
        #expect(
            ChartAccessibility.proportion(strings, kind: .donut, names: ["a", "b", "c", "d", "e", "f", "g", "h"])
                == "Donut chart with 8 segments: a, b, c, d, e, f, and 2 more")
    }

    @Test func sparklineReportsCountAndRoundedRange() {
        #expect(ChartAccessibility.sparkline(strings, values: [3, 1, 4, 1, 5]) == "Sparkline of 5 points, ranging 1 to 5")
        #expect(
            ChartAccessibility.sparkline(strings, values: [-402.5, 81.26999999999998, 0.1 + 0.2])
                == "Sparkline of 3 points, ranging -402.5 to 81.27")
        #expect(ChartAccessibility.sparkline(strings, values: []) == "Sparkline, no data")
        #expect(ChartAccessibility.sparkline(strings, values: [.nan, .infinity]) == "Sparkline, no data")
    }
}
