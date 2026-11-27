import Foundation
import SwiftUI
import Testing

@testable import VisionNativeUI

/// The 2026-11-22 Swift vs React audit's motion, feedback and control findings.
@MainActor
@Suite("Control behaviour parity")
struct ControlBehaviourParityTests {
    /// Finding 30: quick letters build a prefix; a pause or a repeated letter cycles single letters.
    @Test func selectTypeaheadBuildsAPrefixAndCyclesRepeatedLetters() {
        let items = [(index: 0, title: "Belgium"), (index: 1, title: "Brazil"), (index: 2, title: "Bulgaria")]
        var buffer = SelectTypeahead()
        let start = Date(timeIntervalSince1970: 0)
        #expect(SelectTypeahead.match(buffer.append("b", at: start), in: items, current: nil) == 0)
        #expect(SelectTypeahead.match(buffer.append("r", at: start + 0.2), in: items, current: 0) == 1)
        var repeated = SelectTypeahead()
        _ = repeated.append("b", at: start)
        #expect(SelectTypeahead.match(repeated.append("b", at: start + 0.2), in: items, current: 0) == 1)
        var paused = SelectTypeahead()
        _ = paused.append("b", at: start)
        #expect(paused.append("u", at: start + 2) == "u")
    }

    /// Finding 31: the menu's arrow keys walk enabled items without wrapping.
    @Test func menuArrowKeysStepWithoutWrapping() {
        let ids = [UUID(), UUID(), UUID()]
        #expect(VisionMenuNavigator.step(nil, by: 1, in: ids) == ids[0])
        #expect(VisionMenuNavigator.step(nil, by: -1, in: ids) == ids[2])
        #expect(VisionMenuNavigator.step(ids[2], by: 1, in: ids) == ids[2])
        #expect(VisionMenuNavigator.step(ids[0], by: 1, in: ids) == ids[1])
        #expect(VisionMenuNavigator.step(nil, by: 1, in: []) == nil)
    }

    /// Finding 24: a pointer-opened dialog shrinks toward the press.
    @Test func genieAnchorIsThePressInsideThePanel() {
        let frame = CGRect(x: 100, y: 100, width: 400, height: 200)
        #expect(GenieOrigin.anchor(CGPoint(x: 100, y: 300), in: frame) == UnitPoint(x: 0, y: 1))
        #expect(GenieOrigin.anchor(nil, in: frame) == nil)
        #expect(GenieOrigin.anchor(CGPoint(x: 1, y: 1), in: .zero) == nil)
    }

    /// Finding 7: the income share, half and half when both are zero.
    @Test func incomeSpendingSplit() {
        #expect(HomeIncomeSpendingBar.incomeShare(income: 300, spending: 100) == 75)
        #expect(HomeIncomeSpendingBar.incomeShare(income: 0, spending: 0) == 50)
    }

    /// Finding 29: 100 years back to 20 ahead, widened to the chosen and shown years.
    @Test func calendarYearRange() {
        #expect(VisionCalendarGrid.yearRange(selectedYear: nil, shownYear: 2026, currentYear: 2026) == 1926...2046)
        #expect(VisionCalendarGrid.yearRange(selectedYear: 1900, shownYear: 1900, currentYear: 2026) == 1900...2046)
    }

    /// Finding 22: the announcement carries the notice's detail.
    @Test func noticeAnnouncementIncludesTheDetail() {
        #expect(NativeNoticeHost.announcement("Save failed", detail: "Disk full") == "Save failed. Disk full")
        #expect(NativeNoticeHost.announcement("Saved", detail: nil) == "Saved")
    }

    /// Finding 18: Reduce Motion keeps a pressed control's size.
    @Test func pressedControlsKeepTheirSizeUnderReduceMotion() {
        #expect(VisionControlMetrics.pressScale(true, reduceMotion: true) == 1)
        #expect(VisionControlMetrics.pressScale(true, reduceMotion: false) < 1)
        #expect(VisionControlMetrics.pressScale(false, reduceMotion: false) == 1)
    }
}
