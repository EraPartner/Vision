import Foundation
import Testing

@testable import VisionNativeCore

private func series(_ key: String, _ values: [Double?], primary: Bool = false) -> ChartScrubSeries {
    ChartScrubSeries(key: key, label: key.uppercased(), primary: primary) { values.indices.contains($0) ? values[$0] : nil }
}

/// chartScrub.test (scrub.ts): the range-compare gesture, rows and readout text.
@Suite("Chart range compare")
struct ChartRangeCompareTests {
    @Test func aDragComparesEitherDirectionAndStaysAfterReleaseUntilTheNextClick() {
        var scrub = ChartScrub()
        scrub.press(4, x: 100)
        scrub.hover(1, x: 40)
        #expect(scrub.range == ChartScrubRange(startIndex: 1, endIndex: 4))
        scrub.release()
        #expect(scrub.phase == .pinned)
        // Pinned: the pointer no longer moves it.
        scrub.hover(2, x: 60)
        #expect(scrub.range == ChartScrubRange(startIndex: 1, endIndex: 4))
        // A click on a pinned range clears it.
        scrub.press(3, x: 80)
        scrub.release()
        #expect(!scrub.scrubbing && scrub.range == nil)
    }

    @Test func clickAnchorsMovingStretchesAndASecondClickPins() {
        var scrub = ChartScrub()
        scrub.press(2, x: 50)
        scrub.release()
        #expect(scrub.phase == .follow && scrub.anchor == 2 && scrub.range == nil)
        scrub.hover(5, x: 120)
        #expect(scrub.range == ChartScrubRange(startIndex: 2, endIndex: 5))
        scrub.press(6, x: 140)
        #expect(scrub.phase == .pinned && scrub.range == ChartScrubRange(startIndex: 2, endIndex: 6))
        // A second click on the anchor cancels instead.
        var cancelled = ChartScrub()
        cancelled.press(2, x: 50)
        cancelled.release()
        cancelled.press(3, x: 52)
        #expect(!cancelled.scrubbing)
    }

    @Test func aPressThatWobblesAFewPointsIsStillAClick() {
        var scrub = ChartScrub()
        scrub.press(10, x: 200)
        scrub.hover(11, x: 203)
        #expect(scrub.head == 10)
        scrub.release()
        #expect(scrub.phase == .follow)
    }

    @Test func shiftArrowsAnchorExtendFromTheHeadAndAPlainStepEndsIt() {
        var scrub = ChartScrub()
        #expect(scrub.key(.right, shift: true, index: 3, count: 10) == 4)
        #expect(scrub.range == ChartScrubRange(startIndex: 3, endIndex: 4))
        // Extends from the range's end, not the highlight.
        #expect(scrub.key(.right, shift: true, index: 0, count: 10) == 5)
        #expect(scrub.range == ChartScrubRange(startIndex: 3, endIndex: 5))
        // A keyboard range holds against pointer moves.
        scrub.hover(8, x: 300)
        #expect(scrub.range?.endIndex == 5)
        #expect(scrub.key(.left, shift: false, index: 5, count: 10) == 4)
        #expect(!scrub.scrubbing)
        #expect(scrub.key(.left, shift: false, index: nil, count: 10) == 9)
        #expect(scrub.key(.end, shift: false, index: 2, count: 10) == 9)
    }

    @Test func aNewTimelineDropsTheRangeAndTheSameOneKeepsIt() {
        var scrub = ChartScrub()
        scrub.sync(timeline: "3:a:c")
        scrub.press(0, x: 0)
        scrub.hover(2, x: 90)
        scrub.release()
        scrub.sync(timeline: "3:a:c")
        #expect(scrub.range != nil)
        scrub.sync(timeline: "4:a:d")
        #expect(scrub.range == nil && scrub.phase == .idle)
    }

    @Test func rowsLeadWithThePrimaryAndReadPartialSeriesFromTheirNearestValues() throws {
        var scrub = ChartScrub()
        scrub.begin(0)
        scrub.move(3)
        let lines = [
            series("peer", [1, 2, 3, 4]),
            series("main", [10, 11, 12, 8], primary: true),
            series("late", [nil, 5, 6, nil]),
            series("single", [nil, 7, nil, nil]),
        ]
        let view = try #require(ChartScrubView(scrub, count: 4, series: lines))
        #expect(view.rows.map(\.key) == ["main", "peer", "late"])
        #expect(view.lead?.key == "main" && view.trend == .loss)
        #expect(view.labelled && view.isRange)
        let late = try #require(view.rows.last)
        #expect(late.partial && late.startIndex == 1 && late.endIndex == 2 && late.delta == 1)
        // Peers with no primary keep the band neutral; one series tints by itself.
        let peers = try #require(ChartScrubView(scrub, count: 4, series: [lines[0], series("other", [4, 3, 2, 1])]))
        #expect(peers.lead == nil && peers.trend == .neutral)
        let alone = try #require(ChartScrubView(scrub, count: 4, series: [lines[0]]))
        #expect(alone.trend == .gain && !alone.labelled)
        #expect(ChartScrubView(ChartScrub(), count: 4, series: lines) == nil)
    }

    @Test func theDeltaReadsSignedWithAPercentUnlessTheStartIsZeroOrPercentIsOff() {
        let value: (Double) -> String = { String(format: "%.2f", $0) }
        let percent: (Double) -> String = { String(format: "%.1f%%", $0) }
        #expect(ChartScrubDelta.text(start: 100, end: 110, formatValue: value, formatPercent: percent) == "Δ +10.00 (+10.0%)")
        #expect(ChartScrubDelta.text(start: 100, end: 90, formatValue: value, formatPercent: percent) == "Δ −10.00 (−10.0%)")
        #expect(ChartScrubDelta.text(start: 0, end: 5, formatValue: value, formatPercent: percent) == "Δ +5.00")
        #expect(ChartScrubDelta.text(start: 5, end: 5, formatValue: value, formatPercent: nil) == "Δ ±0.00")
        // A formatter that signs its own output loses that sign.
        #expect(ChartScrubDelta.text(start: 1, end: 3, formatValue: { "+ \($0)" }, formatPercent: nil) == "Δ +2.0")
    }
}
