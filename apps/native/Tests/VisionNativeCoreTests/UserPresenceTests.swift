import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite struct UserPresenceTests {
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
