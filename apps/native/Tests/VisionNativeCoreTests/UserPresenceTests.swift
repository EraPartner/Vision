import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite struct UserPresenceTests {
    @Test func decorativeIdleDoesNotPauseDataAndInputResumesIt() {
        let presence = UserPresence()
        presence.update(idleSeconds: 29.9)
        #expect(presence.permitsDecorativeMotion(windowIsLive: true, modalIsOpen: false))
        #expect(presence.nextCheck(idleSeconds: 29.9) == 1)
        #expect(presence.nextCheck(idleSeconds: 0) == 30)
        presence.update(idleSeconds: 30)
        #expect(presence.isDecorativelyIdle)
        #expect(!presence.isAway)
        #expect(!presence.permitsDecorativeMotion(windowIsLive: true, modalIsOpen: false))
        #expect(presence.nextCheck(idleSeconds: 30) == 60)
        presence.noteLocalInput()
        #expect(presence.permitsDecorativeMotion(windowIsLive: true, modalIsOpen: false))
        presence.update(idleSeconds: 0)
        #expect(!presence.permitsDecorativeMotion(windowIsLive: false, modalIsOpen: false))
        #expect(!presence.permitsDecorativeMotion(windowIsLive: true, modalIsOpen: true))
        presence.setScreenLocked(true, idleSeconds: 0)
        #expect(presence.isDecorativelyIdle)
        presence.setScreenLocked(false, idleSeconds: 0)
        #expect(!presence.isDecorativelyIdle)
    }

    @Test func powerAndThermalPolicyOnlyPausesDecoration() {
        let presence = UserPresence()
        for (lowPower, thermal) in [(true, false), (false, true), (true, true)] {
            presence.updatePower(lowPower: lowPower, thermalPressure: thermal)
            #expect(!presence.permitsDecorativeMotion(windowIsLive: true, modalIsOpen: false))
            #expect(!presence.isAway)
        }
        presence.updatePower(lowPower: false, thermalPressure: false)
        #expect(presence.permitsDecorativeMotion(windowIsLive: true, modalIsOpen: false))
        presence.updatePower(lowPower: false, thermalPressure: false, thermalFair: true)
        #expect(presence.throttlesDecoration)
        #expect(presence.permitsDecorativeMotion(windowIsLive: true, modalIsOpen: false))
        presence.updatePower(lowPower: true, thermalPressure: false, thermalFair: true)
        #expect(!presence.throttlesDecoration)
    }

    @Test func fiveIdleMinutesOrALockedScreenIsAwayAndInputOrUnlockReturns() {
        let presence = UserPresence()
        presence.update(idleSeconds: 299)
        #expect(!presence.isAway)
        presence.update(idleSeconds: 300)
        #expect(presence.isAway)
        presence.update(idleSeconds: 2)
        #expect(!presence.isAway)
        presence.setScreenLocked(true, idleSeconds: 0)
        #expect(presence.isAway)
        // A check while locked stays away whatever the input clock says.
        presence.update(idleSeconds: 0)
        #expect(presence.isAway)
        presence.setScreenLocked(false, idleSeconds: 0)
        #expect(!presence.isAway)
    }
}
