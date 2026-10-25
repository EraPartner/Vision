import Testing

@testable import VisionNativeCore

@Suite struct AuroraPlaybackTests {
    @Test func staticAndReducedMotionHoldAFrameEvenWhenIdle() {
        #expect(AuroraPlayback.resolve(motionAllowed: false, windowIsLive: true) == .held)
        #expect(AuroraPlayback.resolve(motionAllowed: false, windowIsLive: false) == .held)
    }

    @Test func anIdleWindowPausesAndALiveOneLoops() {
        #expect(AuroraPlayback.resolve(motionAllowed: true, windowIsLive: false) == .paused)
        #expect(AuroraPlayback.resolve(motionAllowed: true, windowIsLive: true) == .loop)
    }

    @Test func aWindowIsLiveOnlyWhenKeyVisibleAndTheAppShown() {
        func live(_ key: Bool, _ onScreen: Bool, _ mini: Bool, _ hidden: Bool) -> Bool {
            AuroraPlayback.windowIsLive(isKey: key, isOnScreen: onScreen, isMiniaturized: mini, appIsHidden: hidden)
        }
        #expect(live(true, true, false, false))
        #expect(!live(false, true, false, false))
        #expect(!live(true, false, false, false))
        #expect(!live(true, true, true, false))
        #expect(!live(true, true, false, true))
    }

    @Test func theClockHoldsWhilePausedAndResumesFromWhereItStopped() {
        var clock = AuroraDriftClock()
        #expect(clock.elapsed(at: 100) == 0)
        clock.setRunning(true, now: 100)
        clock.setRunning(true, now: 105)
        #expect(clock.elapsed(at: 110) == 10)
        clock.setRunning(false, now: 110)
        #expect(clock.elapsed(at: 500) == 10)
        clock.setRunning(false, now: 600)
        clock.setRunning(true, now: 700)
        #expect(clock.elapsed(at: 705) == 15)
        #expect(clock.isRunning)
    }

    @Test func theDriftAlternatesBetweenZeroAndOneOnTheQuartCurve() {
        let curve = DesignTokens.Ease.inOutQuart
        func progress(_ elapsed: Double) -> Double {
            AuroraDriftClock.progress(elapsed: elapsed, duration: 64, curve: curve)
        }
        #expect(progress(0) == 0)
        #expect(abs(progress(64) - 1) < 1e-9)
        #expect(abs(progress(128)) < 1e-9)
        #expect(abs(progress(64 * 3) - 1) < 1e-9)
        // In-out: slow at the ends, quick in the middle, and monotonic on the way out.
        #expect(progress(6.4) < 0.1)
        #expect(progress(32) > 0.4 && progress(32) < 0.7)
        #expect(progress(20) < progress(30))
        // The way back mirrors the way out in time.
        #expect(abs(progress(64 + 16) - progress(64 - 16)) < 1e-9)
    }
}
