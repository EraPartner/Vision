import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct ChartLinePlotTests {
    private func plot(_ count: Int, maxMarks: Int = 400) -> ChartLinePlot {
        let points = (0..<count).map { index in
            ChartLinePlot.Input(
                time: Decimal(index * 86_400_000), close: Decimal(index % 11),
                volume: index % 2 == 0 ? Decimal(index) : nil)
        }
        return ChartLinePlot(points: points, maxMarks: maxMarks)
    }

    @Test func aShortSeriesDrawsEveryCloseAndAVolumeBarPerVolume() {
        let plot = plot(10)
        #expect(plot.marks.count == 10)
        #expect(plot.bars.count == 5)
        #expect(plot.times.count == 10)
        #expect(plot.marks[3].time == Date(timeIntervalSince1970: 3 * 86_400))
    }

    @Test func aLongSeriesDrawsFewerMarksButKeepsEveryCloseForTheDomain() {
        let plot = plot(5_000)
        #expect(plot.marks.count <= 400)
        #expect(plot.closes.count == 5_000)
        #expect(plot.marks.first?.offset == 0)
        #expect(plot.marks.last?.offset == 4_999)
    }

    @Test func theNearestPointComesFromBisection() {
        let plot = plot(100)
        #expect(plot.nearestOffset(to: Date(timeIntervalSince1970: 40 * 86_400 + 100)) == 40)
        #expect(plot.nearestOffset(to: Date(timeIntervalSince1970: 40 * 86_400 + 80_000)) == 41)
        #expect(plot.nearestOffset(to: Date(timeIntervalSince1970: -5)) == 0)
        #expect(plot.nearestOffset(to: Date(timeIntervalSince1970: 9_999_999_999)) == 99)
        #expect(ChartLinePlot(points: []).nearestOffset(to: Date()) == nil)
    }
}
