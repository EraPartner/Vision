import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct ChartPlotSupportTests {
    private func series(_ id: String, _ keys: [String]) -> InsightChartSeries {
        InsightChartSeries(
            id: id, label: id, points: keys.map { InsightChartPoint(key: $0, value: Decimal(1)) })
    }

    @Test func theLayoutSortsTheDistinctKeysOfEverySeriesAndIndexesThem() {
        let layout = ChartKeyLayout(series: [series("a", ["2026-03", "2026-01"]), series("b", ["2026-02", "2026-01"])])
        #expect(layout.keys == ["2026-01", "2026-02", "2026-03"])
        #expect(layout.index["2026-02"] == 1)
        #expect(layout.index["2026-03"] == 2)
    }

    @Test func theCacheBuildsOncePerSeriesValue() {
        let cache = ChartKeyLayoutCache()
        let first = [series("a", ["2026-01", "2026-02"])]
        _ = cache.layout(for: first)
        _ = cache.layout(for: first)
        _ = cache.layout(for: [series("a", ["2026-01", "2026-02"])])
        #expect(cache.builds == 1)
        _ = cache.layout(for: [series("a", ["2026-01", "2026-04"])])
        #expect(cache.builds == 2)
    }

    @Test func theLabelMemoFormatsOncePerKeyUntilTheContextChanges() {
        let memo = ChartLabelMemo()
        var made = 0
        for _ in 0..<3 {
            _ = memo.label("2026-01-01", context: "en|EUR") {
                made += 1
                return "1 Jan 2026"
            }
        }
        #expect(made == 1)
        _ = memo.label("2026-01-01", context: "nl|EUR") {
            made += 1
            return "1 jan. 2026"
        }
        #expect(made == 2)
        #expect(memo.misses == 2)
    }

    @Test func aShortSeriesIsNotThinned() {
        let values = (0..<500).map(Double.init)
        #expect(ChartDecimation.indices(of: values) == Array(0..<500))
    }

    @Test func aLongSeriesKeepsItsEndsPeaksAndTroughsInOrder() {
        var values = (0..<10_000).map { Double($0 % 7) }
        values[4_321] = 900
        values[7_654] = -900
        let kept = ChartDecimation.indices(of: values, maxPoints: 400)
        #expect(kept.count <= 402)
        #expect(kept.first == 0)
        #expect(kept.last == 9_999)
        #expect(kept.contains(4_321))
        #expect(kept.contains(7_654))
        #expect(kept == kept.sorted())
        #expect(Set(kept).count == kept.count)
    }

    @Test func theBudgetIsOneBucketPairPerTwoPointsOfPlusTheEnds() {
        #expect(ChartDecimation.budget(plotWidth: 960) == 962)
        #expect(ChartDecimation.budget(plotWidth: 1) == 4)
        #expect(ChartDecimation.lineBudget == 962)
        let values = (0..<5_000).map { Double($0 % 11) }
        #expect(ChartDecimation.indices(of: values, maxPoints: ChartDecimation.lineBudget).count <= 962)
    }

    private func daily(_ id: String, count: Int, spike: Int? = nil) -> InsightChartSeries {
        InsightChartSeries(
            id: id, label: id,
            points: (0..<count).map { day in
                InsightChartPoint(
                    key: String(format: "%05d", day), value: day == spike ? Decimal(900) : Decimal(day % 7))
            })
    }

    @Test func thePlotThinsLongLinesButKeepsTheFullKeysAndValues() {
        let plot = ChartSeriesPlot(series: [daily("a", count: 5_000, spike: 2_500), daily("b", count: 50)])
        #expect(plot.layout.keys.count == 5_000)
        #expect(plot.values.count == 5_050)
        #expect(plot.values.max() == 900)
        #expect(plot.drawn[0].points.count <= ChartDecimation.lineBudget)
        #expect(plot.drawn[0].points.first?.key == "00000")
        #expect(plot.drawn[0].points.last?.key == "04999")
        #expect(plot.drawn[0].points.contains { $0.key == "02500" })
        #expect(plot.drawn[1] == daily("b", count: 50))
    }

    @Test func aShortSeriesIsDrawnAsIs() {
        let lines = [daily("a", count: 300), daily("b", count: 300)]
        #expect(ChartSeriesPlot(series: lines).drawn == lines)
        #expect(ChartSeriesPlot(series: lines, shared: true).drawn == lines)
    }

    @Test func sharedThinningKeepsEveryLineOnTheSameKeys() {
        let plot = ChartSeriesPlot(
            series: [daily("a", count: 4_000, spike: 1_000), daily("b", count: 4_000, spike: 3_000)], shared: true)
        let first = plot.drawn[0].points.map(\.key)
        #expect(first == plot.drawn[1].points.map(\.key))
        #expect(first.count < 4_000)
        #expect(first.contains("01000"))
        #expect(first.contains("03000"))
    }

    @Test func thePlotCacheBuildsOncePerSeriesValue() {
        let cache = ChartSeriesPlotCache()
        let lines = [daily("a", count: 10)]
        _ = cache.plot(for: lines)
        _ = cache.plot(for: lines)
        #expect(cache.builds == 1)
        _ = cache.plot(for: lines, shared: true)
        #expect(cache.builds == 2)
        _ = cache.plot(for: [daily("a", count: 11)], shared: true)
        #expect(cache.builds == 3)
    }

    @Test func markLabelsAreFormattedOncePerLineAndContext() {
        let cache = ChartMarkLabelCache()
        let line = daily("a", count: 3)
        var made = 0
        let make: (InsightChartPoint) -> ChartMarkLabelCache.Mark = { point in
            made += 1
            return ChartMarkLabelCache.Mark(label: "a. " + point.key, value: point.value.description)
        }
        let first = cache.marks(for: line, context: "en|EUR", make: make)
        _ = cache.marks(for: line, context: "en|EUR", make: make)
        #expect(made == 3)
        #expect(first[1].label == "a. 00001")
        _ = cache.marks(for: line, context: "nl|EUR", make: make)
        #expect(made == 6)
        _ = cache.marks(for: daily("a", count: 4), context: "nl|EUR", make: make)
        #expect(cache.builds == 3)
    }

    @Test func theDerivedMemoBuildsOncePerInput() {
        let memo = ChartDerivedMemo<[Int], Int>()
        #expect(memo.output(for: [1, 2]) { 3 } == 3)
        #expect(memo.output(for: [1, 2]) { 99 } == 3)
        #expect(memo.output(for: [1, 2, 3]) { 6 } == 6)
        #expect(memo.builds == 2)
    }
}
