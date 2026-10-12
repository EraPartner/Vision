import Darwin
import Foundation
import Testing
@testable import VisionNativeCore

final class FakeInstanceLock: InstanceLocking, @unchecked Sendable {
    private let lock = NSLock()
    private var heldElsewhere: Bool
    private(set) var acquired: [String] = []

    init(heldElsewhere: Bool = false) {
        self.heldElsewhere = heldElsewhere
    }

    func acquire(_ path: String) throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        acquired.append(path)
        return !heldElsewhere
    }
}

final class RecordingLog: RuntimeLogging, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []

    var lines: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func log(_ level: String, _ message: String) {
        lock.lock()
        recorded.append("[\(level)] \(message)")
        lock.unlock()
    }
}

private let bundleResources = "/Applications/Vision Native.app/Contents/Resources"

private func makeSupervisor(
    _ harness: Harness,
    environment: [String: String]? = nil,
    lock: FakeInstanceLock = FakeInstanceLock(),
    log: RecordingLog = RecordingLog()
) -> RuntimeSupervisor {
    RuntimeSupervisor(
        configuration: SupervisorConfiguration(
            environment: environment
                ?? ["PATH": "/usr/bin", "HOME": testHome, RuntimePayload.environmentKey: testRuntimeRoot],
            homeDirectory: testHome,
            resourcesDirectory: bundleResources),
        dependencies: harness.dependencies,
        instanceLock: lock,
        logger: log)
}

@Suite struct RuntimeSupervisorTests {
    @Test func missingPayloadFailsWithAnActionableReason() async throws {
        let harness = try Harness(payload: false)
        let supervisor = makeSupervisor(harness, environment: ["PATH": "/usr/bin", "HOME": testHome])
        let error = await #expect(throws: NativeRuntimeError.self) { try await supervisor.launch() }
        #expect(error?.code == "NATIVE_RUNTIME_MISSING")
        guard case .failed(let reason) = await supervisor.phase else {
            Issue.record("expected a failed phase")
            return
        }
        #expect(reason.contains("install-native.sh"))
        #expect(harness.spawner.spawns.isEmpty)
    }

    @Test func secondInstanceIsRefusedBeforeTouchingTheRuntime() async throws {
        let harness = try Harness()
        harness.installSeed()
        let lock = FakeInstanceLock(heldElsewhere: true)
        let supervisor = makeSupervisor(harness, lock: lock)
        let error = await #expect(throws: NativeRuntimeError.self) { try await supervisor.launch() }
        #expect(error?.code == "NATIVE_ALREADY_RUNNING")
        #expect(lock.acquired == ["\(testUserData)/vision-native.lock"])
        #expect(harness.runner.calls.isEmpty)
        #expect(!harness.fileSystem.exists(harness.layout.env))
    }

    @Test func launchSeedsStartsAndReturnsTheLoopbackURL() async throws {
        let harness = try Harness()
        harness.installSeed()
        let log = RecordingLog()
        let supervisor = makeSupervisor(harness, log: log)
        let url = try await supervisor.launch()
        #expect(url.absoluteString == "http://localhost:41000")
        #expect(await supervisor.phase == .running(url))
        #expect(harness.fileSystem.json(harness.layout.settings)?["appPort"] == .int(41_000))
        #expect(harness.fileSystem.json(harness.layout.state)?["demoSeed"] != nil)
        #expect(harness.http.requests.contains { $0.absoluteString == "http://localhost:41000/health/detailed" })
        #expect(!log.lines.contains { $0.contains("abcdef") })

        let again = try await supervisor.launch()
        #expect(again == url)
        #expect(harness.spawner.spawns.count == 2)
    }

    @Test func shutdownStopsTheBackendAndPostgres() async throws {
        let harness = try Harness()
        harness.installSeed()
        let supervisor = makeSupervisor(harness)
        _ = try await supervisor.launch()
        await supervisor.shutdown()
        #expect(await supervisor.phase == .stopped)
        #expect(harness.processes.sentSignals.map { $0.1 } == [SIGTERM])
        #expect(harness.runner.calls(named: "pg_ctl").count == 1)
        #expect(!harness.fileSystem.exists(harness.layout.pid))
    }

    @Test func keepServicesOnQuitLeavesEverythingRunning() async throws {
        let harness = try Harness()
        harness.installSeed()
        harness.fileSystem.addFile(testUserData + "/settings.json", #"{"keepServicesOnQuit":true}"#)
        let supervisor = makeSupervisor(harness)
        _ = try await supervisor.launch()
        await supervisor.shutdown()
        #expect(harness.processes.sentSignals.isEmpty)
        #expect(harness.runner.calls(named: "pg_ctl").isEmpty)
        #expect(harness.fileSystem.json(harness.layout.settings)?["keepServicesOnQuit"] == .bool(true))
    }

    @Test func databaseSettingOverridesTheSettingsMirror() async throws {
        let harness = try Harness()
        harness.installSeed()
        harness.fileSystem.addFile(testUserData + "/settings.json", #"{"keepServicesOnQuit":true}"#)
        let defaultHandler = harness.http.handler
        harness.http.handler = { url in
            if url.path.hasSuffix("/api/settings/services_settings") {
                return HTTPResponse(
                    status: 200, body: Data(#"{"ok":true,"data":{"value":{"keepServicesOnQuit":false}}}"#.utf8))
            }
            return try defaultHandler(url)
        }
        let supervisor = makeSupervisor(harness)
        _ = try await supervisor.launch()
        await supervisor.shutdown()
        #expect(harness.runner.calls(named: "pg_ctl").count == 1)
    }

    @Test func occupiedPersistedPortIsRepickedOnce() async throws {
        let harness = try Harness()
        harness.installSeed()
        harness.fileSystem.addFile(testUserData + "/settings.json", #"{"appPort":41000}"#)
        harness.ports.occupy(41_000)
        harness.random.ports = [42_000]
        let url = try await makeSupervisor(harness).launch()
        #expect(url.absoluteString == "http://localhost:42000")
        #expect(harness.fileSystem.json(harness.layout.settings)?["appPort"] == .int(42_000))
        let backend = try #require(harness.spawner.spawns.last)
        #expect(backend.environment["PORT"] == "42000")
    }

    @Test func corruptSettingsAreQuarantined() async throws {
        let harness = try Harness()
        harness.installSeed()
        harness.fileSystem.addFile(testUserData + "/settings.json", "{not json")
        _ = try await makeSupervisor(harness).launch()
        #expect(!harness.fileSystem.paths(withPrefix: testUserData + "/settings.json.corrupt-").isEmpty)
        #expect(harness.fileSystem.json(harness.layout.settings)?["appPort"] == .int(41_000))
    }

    @Test func retryAfterAFailedLaunchStartsAgain() async throws {
        let harness = try Harness(payload: false)
        let supervisor = makeSupervisor(harness)
        await #expect(throws: NativeRuntimeError.self) { try await supervisor.launch() }
        harness.installPayload()
        harness.installSeed()
        let url = try await supervisor.launch()
        #expect(url.absoluteString == "http://localhost:41000")
    }

    @Test func shutdownBeforeLaunchIsClean() async throws {
        let harness = try Harness()
        let supervisor = makeSupervisor(harness)
        await supervisor.shutdown()
        #expect(await supervisor.phase == .stopped)
        #expect(harness.runner.calls.isEmpty)
    }
}

@Suite struct FileInstanceLockTests {
    @Test func secondHolderIsRefusedWhileTheFirstHoldsTheLock() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("vision-native-lock-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("vision-native.lock").path

        let first = FileInstanceLock()
        #expect(try first.acquire(path))
        #expect(try first.acquire(path))
        let second = FileInstanceLock()
        #expect(try !second.acquire(path))
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }
}
