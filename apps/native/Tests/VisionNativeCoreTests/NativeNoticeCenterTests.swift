import Foundation
import Testing

@testable import VisionNativeCore

private final class NoticeTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 100)
    func now() -> Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
}

@MainActor @Suite("Global notices and one-slot Undo")
struct NativeNoticeCenterTests {
    @Test func stableSourceToastReplacementKeepsOneEntryAndRetiresItsOldDeadline() {
        let clock = NoticeTestClock()
        let center = NativeNoticeCenter(now: clock.now, automaticExpiry: false)
        var clears = 0
        let first = center.publish(.init(id: 1, kind: .success, key: "first"), source: UUID(),
            replacementKey: "portfolio-refresh-prices", clear: { clears += 1 })
        let revision = center.entries[0].revision
        clock.advance(3)
        let second = center.publish(.init(id: 2, kind: .warning, key: "second"), source: UUID(),
            replacementKey: "portfolio-refresh-prices")
        #expect(first == second && center.entries.count == 1 && clears == 1)
        #expect(center.entries[0].revision != revision && center.entries[0].notice.key == "second")
        clock.advance(2)
        center.expire()
        #expect(center.entries.count == 1)
    }
    @Test func sourceCountersDoNotCollideAndActionUpgradeDoesNotDuplicateNotice() {
        let center = NativeNoticeCenter(now: { Date(timeIntervalSince1970: 100) }, automaticExpiry: false)
        let first = UUID()
        let second = UUID()
        let notice = ScreenNotice(id: 1, kind: .success, key: "common.saved")
        let id = center.publish(notice, source: first)
        center.publish(notice, source: second)
        let upgraded = center.publish(
            notice, source: first, lifetime: 8, actionTitleKey: "common.undo", isUndo: true, action: {})
        #expect(center.entries.count == 2 && id == upgraded)
        #expect(center.hasUndo)
    }

    @Test func onlyNewestUndoAnswersShortcutAndDoubleDispatchCannotReplay() async {
        let center = NativeNoticeCenter(now: { Date(timeIntervalSince1970: 100) }, automaticExpiry: false)
        var restored: [String] = []
        center.publish(
            .init(id: 1, kind: .success, key: "older"), source: UUID(), lifetime: 8,
            actionTitleKey: "common.undo", isUndo: true, action: { restored.append("older") })
        center.publish(
            .init(id: 1, kind: .success, key: "newer"), source: UUID(), lifetime: 8,
            actionTitleKey: "common.undo", isUndo: true,
            action: {
                restored.append("newer")
                await Task.yield()
            })
        async let first = center.consumeUndo()
        async let second = center.consumeUndo()
        let results = await [first, second]
        #expect(results.filter { $0 }.count == 1)
        #expect(restored == ["newer"] && !center.hasUndo)
        #expect(center.entries.count == 1)
    }

    @Test func olderToastKeepsItsCapturedActionButClearsNewestShortcutSlot() async {
        let center = NativeNoticeCenter(now: { Date(timeIntervalSince1970: 100) }, automaticExpiry: false)
        var restored: [String] = []
        let older = center.publish(
            .init(id: 1, kind: .success, key: "older"), source: UUID(), lifetime: 8,
            actionTitleKey: "common.undo", isUndo: true, action: { restored.append("original target") })
        center.publish(
            .init(id: 2, kind: .success, key: "newer"), source: UUID(), lifetime: 8,
            actionTitleKey: "common.undo", isUndo: true, action: { restored.append("new target") })
        #expect(await center.performAction(older))
        #expect(!center.hasUndo && restored == ["original target"])
        #expect(await center.consumeUndo() == false)
        #expect(await center.performAction(older) == false)
    }

    @Test func absoluteDeadlineSurvivesCoverageAndAcceptsExactSourceBoundary() async {
        let clock = NoticeTestClock()
        let center = NativeNoticeCenter(now: clock.now, automaticExpiry: false)
        var restores = 0
        center.publish(
            .init(id: 1, kind: .success, key: "deleted"), source: UUID(), lifetime: 8,
            actionTitleKey: "common.undo", isUndo: true, action: { restores += 1 })
        clock.advance(8)
        center.expire()
        #expect(center.hasUndo)
        #expect(await center.consumeUndo())
        #expect(restores == 1)
        center.publish(
            .init(id: 2, kind: .success, key: "deleted"), source: UUID(), lifetime: 8,
            actionTitleKey: "common.undo", isUndo: true, action: { restores += 1 })
        clock.advance(8.001)
        #expect(await center.consumeUndo() == false)
        #expect(center.entries.isEmpty && restores == 1)
    }

    @Test func ordinaryExpiryClearsOnlyMatchingLocalNoticeWithoutDroppingNewUndo() async {
        let clock = NoticeTestClock()
        let center = NativeNoticeCenter(now: clock.now, automaticExpiry: false)
        var cleared: [Int] = []
        center.publish(.init(id: 1, kind: .info, key: "plain"), source: UUID(), clear: { cleared.append(1) })
        center.publish(
            .init(id: 2, kind: .success, key: "undo"), source: UUID(), lifetime: 8,
            actionTitleKey: "common.undo", isUndo: true, action: {}, clear: { cleared.append(2) })
        clock.advance(4.001)
        center.expire()
        #expect(cleared == [1] && center.hasUndo && center.entries.count == 1)
        #expect(await center.consumeUndo())
        #expect(cleared == [1, 2])
    }
}
