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
}
