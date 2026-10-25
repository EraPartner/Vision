import Foundation
import Testing
@testable import VisionNativeCore

/// The runtime a quiescent capture drives, like the mock in quiescent-snapshot.test.ts.
private actor FakeSnapshotRuntime: SnapshotRuntime {
    private(set) var running = true
    private(set) var auditPaused = false
    private(set) var events: [String] = []
    private let startFailure: NativeRuntimeError?

    init(startFailure: NativeRuntimeError? = nil) {
        self.startFailure = startFailure
    }

    func pauseAuditClosure() async {
        auditPaused = true
        events.append("pause")
    }

    func stop(keepPostgres: Bool) async throws {
        #expect(auditPaused)
        #expect(keepPostgres)
        running = false
        events.append("stop")
    }

    func startBackendAndWait() async throws {
        events.append("start")
        if let startFailure { throw startFailure }
        running = true
    }

    func resumeAuditClosure() async {
        auditPaused = false
        events.append("resume")
    }
}

@Suite struct QuiescentSnapshotTests {
    @Test(arguments: [false, true])
    func theSnapshotBlocksWritersAndResumesTheRuntime(_ fails: Bool) async throws {
        let runtime = FakeSnapshotRuntime()
        let capture = { @Sendable () async throws -> String in
            let running = await runtime.running
            let paused = await runtime.auditPaused
            #expect(!running)
            #expect(paused)
            if fails { throw NativeRuntimeError("DUMP_FAILED", "dump failed") }
            return "snapshot"
        }
        if fails {
            let error = await #expect(throws: NativeRuntimeError.self) {
                try await QuiescentSnapshot.capture(runtime, capture)
            }
            #expect(error?.code == "DUMP_FAILED")
        } else {
            let value = try await QuiescentSnapshot.capture(runtime, capture)
            #expect(value == "snapshot")
        }
        let running = await runtime.running
        let paused = await runtime.auditPaused
        let events = await runtime.events
        #expect(running)
        #expect(!paused)
        #expect(events == ["pause", "stop", "start", "resume"])
    }

    @Test func aRestartFailureIsSurfacedAndTheAuditPauseReleased() async throws {
        let runtime = FakeSnapshotRuntime(startFailure: NativeRuntimeError("RESTART_FAILED", "restart failed"))
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await QuiescentSnapshot.capture(runtime) { @Sendable () async throws -> String in "snapshot" }
        }
        #expect(error?.code == "RESTART_FAILED")
        let paused = await runtime.auditPaused
        let events = await runtime.events
        #expect(!paused)
        #expect(events == ["pause", "stop", "start", "resume"])
    }
}
