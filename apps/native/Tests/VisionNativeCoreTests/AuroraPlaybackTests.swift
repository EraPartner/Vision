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

    @Test func theBlobsKeepTheirCSSPlacementAndDriftEnds() {
        func close(_ value: Double, _ expected: Double) -> Bool { abs(value - expected) < 1e-9 }
        let first = AuroraBlobDrift.first(width: 1000, height: 800)
        #expect(close(first.diameter, 550))
        #expect(close(first.centerX, 155) && close(first.centerY, 131))
        #expect(first.duration == 64)
        let firstEnd = first.pose(at: 1)
        #expect(close(firstEnd.scale, 1.18) && close(firstEnd.x, 140) && close(firstEnd.y, 72))
        let second = AuroraBlobDrift.second(width: 1000, height: 800)
        #expect(close(second.diameter, 480))
        #expect(close(second.centerX, 860) && close(second.centerY, 736))
        #expect(second.duration == 76)
        let rest = second.pose(at: 0)
        #expect(close(rest.scale, 1.12) && close(rest.x, 0) && close(rest.y, 0))
        // A narrow window keeps the minimum diameters.
        #expect(close(AuroraBlobDrift.first(width: 600, height: 400).diameter, 544))
        #expect(close(AuroraBlobDrift.second(width: 600, height: 400).diameter, 480))
    }

    @Test func theShaderClockOnlyRunsWhileLoopingAndCapsALongGap() {
        var clock = AuroraShaderClock()
        #expect(clock.frame(at: 10) == 0)
        #expect(abs(clock.frame(at: 10.05) - 0.05) < 1e-9)
        // A stalled main thread counts as one step.
        #expect(abs(clock.frame(at: 12) - 0.15) < 1e-9)
        clock.stop()
        // Resumes where it stopped after a pause.
        #expect(abs(clock.frame(at: 60) - 0.15) < 1e-9)
        #expect(abs(clock.frame(at: 60.05) - 0.2) < 1e-9)
    }

    @MainActor @Test func theModalRegistryCountsNestedModals() {
        let registry = VisionModalRegistry()
        registry.opened()
        registry.opened()
        registry.closed()
        #expect(registry.isOpen)
        registry.closed()
        registry.closed()
        #expect(!registry.isOpen && registry.openCount == 0)
    }

    @Test func theShaderBlobsRestUnscaledAndDriftAlongTheSameLeg() {
        let second = AuroraBlobDrift.second(width: 1000, height: 800)
        let rest = second.circle(progress: nil)
        #expect(abs(rest.radius - 240 * 0.72) < 1e-9)
        #expect(abs(rest.x - second.centerX) < 1e-9 && abs(rest.y - second.centerY) < 1e-9)
        let end = second.circle(progress: 1)
        #expect(abs(end.radius - 240 * 0.72 * 0.96) < 1e-9)
        #expect(abs(end.x - (second.centerX - 110)) < 1e-9 && abs(end.y - (second.centerY - 56)) < 1e-9)
    }
}
