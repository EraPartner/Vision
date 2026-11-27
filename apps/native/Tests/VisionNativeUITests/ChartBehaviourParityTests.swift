import CoreGraphics
import SwiftUI
import Testing
import VisionNativeCore

@testable import VisionNativeUI

/// Behaviour differences from the web app found by the 2026-11-22 Swift vs React audit.
@MainActor
@Suite("Chart and motion behaviour parity")
struct ChartBehaviourParityTests {
    private func volumes(_ values: [Decimal]) -> MarketVolumeBars {
        let inputs = values.enumerated().map { offset, volume in
            ChartLinePlot.Input(time: Decimal(offset * 60_000), close: 1, volume: volume)
        }
        return MarketVolumeBars(
            bars: ChartLinePlot(points: inputs).bars, count: inputs.count, color: .gray, label: "Volume",
            onHover: { _ in })
    }

    /// Finding 4: a refresh that changes only a middle volume must redraw that bar.
    @Test func volumeBarsRedrawWhenOnlyAMiddleVolumeChanges() {
        #expect(volumes([10, 20, 30]) == volumes([10, 20, 30]))
        #expect(volumes([10, 20, 30]) != volumes([10, 25, 30]))
    }

    /// Finding 5: two points at the same X far apart vertically are each found under the pointer,
    /// and empty plot space reads nothing.
    @Test func scatterHitTestUsesBothCoordinatesAndTheSeries() {
        let marks = [
            AnalysisScatterHit.Mark(row: 0, series: 0, center: CGPoint(x: 100, y: 40)),
            AnalysisScatterHit.Mark(row: 1, series: 0, center: CGPoint(x: 100, y: 200)),
            AnalysisScatterHit.Mark(row: 1, series: 1, center: CGPoint(x: 100, y: 120)),
        ]
        let radius = AnalysisScatterHit.radius
        #expect(AnalysisScatterHit.nearest(to: CGPoint(x: 101, y: 42), marks: marks, radius: radius) == marks[0])
        #expect(AnalysisScatterHit.nearest(to: CGPoint(x: 99, y: 198), marks: marks, radius: radius) == marks[1])
        #expect(AnalysisScatterHit.nearest(to: CGPoint(x: 100, y: 121), marks: marks, radius: radius) == marks[2])
        #expect(AnalysisScatterHit.nearest(to: CGPoint(x: 100, y: 80), marks: marks, radius: radius) == nil)
    }

    /// Finding 17: a page that appeared under Reduce Motion stays visible when it is turned off.
    @Test func pageEntranceSettlesUnderReduceMotion() {
        #expect(PageEntrance.settleAnimation(reduceMotion: true) == nil)
        #expect(PageEntrance.settleAnimation(reduceMotion: false) != nil)
        // onAppear always sets `entered`; with it set, the page shows whatever the preference.
        #expect(PageEntrance.shown(entered: true, reduceMotion: false))
        #expect(!PageEntrance.shown(entered: false, reduceMotion: false))
    }
}
