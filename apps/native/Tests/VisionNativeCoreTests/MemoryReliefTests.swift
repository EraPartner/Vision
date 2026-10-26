import Foundation
import Synchronization
import Testing

@testable import VisionNativeCore

@Suite struct MemoryReliefTests {
    private final class Probe: Sendable {
        let bytes = Mutex<UInt64>(0)
        let relieved = Mutex(0)
        let pauses = Mutex(0)

        func make() -> MemoryRelief {
            MemoryRelief(
                footprint: { [self] in bytes.withLock { $0 } },
                relieve: { [self] in
                    relieved.withLock { $0 += 1 }
                    bytes.withLock { $0 = $0 > 104_857_600 ? $0 - 104_857_600 : 0 }
                },
                pause: { [self] _ in pauses.withLock { $0 += 1 } })
        }
    }

    private let mb: UInt64 = 1_048_576

    @Test func relievesOnceAfterTheFootprintGrew() async {
        let probe = Probe()
        let relief = probe.make()
        probe.bytes.withLock { $0 = 500 * mb }
        relief.request()
        await relief.settled()
        #expect(probe.relieved.withLock { $0 } == 1)
        #expect(probe.bytes.withLock { $0 } == 400 * mb)
    }

    @Test func skipsWhileTheFootprintHasNotGrownEnough() async {
        let probe = Probe()
        let relief = probe.make()
        probe.bytes.withLock { $0 = 500 * mb }
        relief.request()
        await relief.settled()
        probe.bytes.withLock { $0 += 10 * mb }
        relief.request()
        await relief.settled()
        #expect(probe.relieved.withLock { $0 } == 1)
        probe.bytes.withLock { $0 += 40 * mb }
        relief.request()
        await relief.settled()
        #expect(probe.relieved.withLock { $0 } == 2)
    }

    @Test func aForcedRequestRelievesWithoutGrowth() async {
        let probe = Probe()
        let relief = probe.make()
        probe.bytes.withLock { $0 = 500 * mb }
        relief.request()
        await relief.settled()
        relief.request(force: true)
        await relief.settled()
        #expect(probe.relieved.withLock { $0 } == 2)
    }

    @Test func requestsMadeWhileOneIsPendingShareIt() async {
        let probe = Probe()
        let relief = probe.make()
        probe.bytes.withLock { $0 = 500 * mb }
        relief.request()
        relief.request()
        relief.request()
        await relief.settled()
        #expect(probe.pauses.withLock { $0 } <= 3)
        #expect(probe.relieved.withLock { $0 } == 1)
    }
}
