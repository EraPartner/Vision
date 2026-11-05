import Testing

@testable import VisionNativeCore

@Suite struct BackendHealthWatchdogTests {
    @Test func threeConsecutiveFailuresReportLostOnceAndRecoveryReportsRestored() {
        var watchdog = BackendHealthWatchdog()
        #expect(watchdog.record(healthy: false) == nil)
        #expect(watchdog.record(healthy: false) == nil)
        #expect(watchdog.record(healthy: false) == .lost)
        #expect(watchdog.record(healthy: false) == nil)
        #expect(watchdog.reportedLost)
        #expect(watchdog.record(healthy: true) == .restored)
        #expect(watchdog.record(healthy: true) == nil)
    }

    @Test func aHealthyProbeResetsTheFailureCount() {
        var watchdog = BackendHealthWatchdog()
        _ = watchdog.record(healthy: false)
        _ = watchdog.record(healthy: false)
        #expect(watchdog.record(healthy: true) == nil)
        #expect(watchdog.record(healthy: false) == nil)
        #expect(watchdog.record(healthy: false) == nil)
        #expect(watchdog.record(healthy: false) == .lost)
    }

    @Test func healthMatchesPingHealth() {
        #expect(BackendHealthWatchdog.isHealthy(status: 200))
        #expect(BackendHealthWatchdog.isHealthy(status: 302))
        #expect(!BackendHealthWatchdog.isHealthy(status: 400))
        #expect(!BackendHealthWatchdog.isHealthy(status: 503))
        #expect(!BackendHealthWatchdog.isHealthy(status: nil))
    }
}
