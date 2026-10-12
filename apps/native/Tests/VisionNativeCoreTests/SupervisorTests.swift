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
    private var rotateCount = 0

    var rotations: Int { lock.withLock { rotateCount } }

    func rotate() {
        lock.withLock { rotateCount += 1 }
    }

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
    log: RecordingLog = RecordingLog(),
    readinessAttempts: Int = 600
) -> RuntimeSupervisor {
    RuntimeSupervisor(
        configuration: SupervisorConfiguration(
            environment: environment
                ?? ["PATH": "/usr/bin", "HOME": testHome, RuntimePayload.environmentKey: testRuntimeRoot],
            homeDirectory: testHome,
            resourcesDirectory: bundleResources,
            readinessAttempts: readinessAttempts,
            allowPayloadOverride: true),
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

    @Test func readinessFailsThenRetrySucceeds() async throws {
        let harness = try Harness()
        harness.installSeed()
        let ready = LockedValue(false)
        let defaultHandler = harness.http.handler
        // Only the supervisor's own readiness poll (http://localhost) fails at first; the
        // Demo switch's detailed check on 127.0.0.1 passes.
        harness.http.handler = { url in
            if url.absoluteString.hasPrefix("http://localhost:"), url.path.hasSuffix("/health/detailed"),
                !ready.withLock({ $0 })
            {
                return HTTPResponse(status: 503)
            }
            return try defaultHandler(url)
        }
        let supervisor = makeSupervisor(harness, readinessAttempts: 3)
        let error = await #expect(throws: NativeRuntimeError.self) { try await supervisor.launch() }
        #expect(error?.code == "BACKEND_NOT_READY")
        guard case .failed = await supervisor.phase else {
            Issue.record("expected a failed phase")
            return
        }
        let firstBackend = try #require(harness.spawner.spawns.last)
        #expect(firstBackend.executable.hasSuffix("/vision-backend"))
        #expect(harness.processes.sentSignals.map { $0.0 } == [firstBackend.pid])
        #expect(harness.processes.sentSignals.map { $0.1 } == [SIGTERM])
        #expect(!harness.processes.exists(firstBackend.pid))
        #expect(!harness.fileSystem.exists(harness.layout.pid))
        #expect(harness.postgresRunning)
        #expect(harness.runner.calls(named: "pg_ctl").isEmpty)

        ready.withLock { $0 = true }
        let url = try await supervisor.launch()
        #expect(url.absoluteString == "http://localhost:41000")
        #expect(await supervisor.phase == .running(url))
        let backends = harness.spawner.spawns.filter { $0.executable.hasSuffix("/vision-backend") }
        #expect(backends.count == 2)
        #expect(harness.fileSystem.json(harness.layout.pid)?["pid"] == .int(Int(backends[1].pid)))
    }

    @Test(.timeLimit(.minutes(1))) func shutdownDuringPrepareStopsServices() async throws {
        let harness = try Harness()
        harness.installSeed()
        let restoring = Latch()
        let release = Latch()
        harness.runner.gate = { call in
            guard call.name == "pg_restore", !call.arguments.contains("--list") else { return }
            restoring.open()
            await release.wait()
        }
        let supervisor = makeSupervisor(harness)
        let launch = Task { try await supervisor.launch() }
        await restoring.wait()
        #expect(await supervisor.phase == .seedingDemo)

        // Returns while pg_restore is still in flight.
        await supervisor.shutdown()
        #expect(await supervisor.phase == .stopped)
        #expect(harness.runner.calls(named: "pg_ctl").count == 1)
        #expect(!harness.postgresRunning)
        let dropped = harness.runner.calls(named: "psql").contains { call in
            call.arguments.contains { $0.hasPrefix("DROP DATABASE \"vision_native_restore_") }
        }
        #expect(dropped)

        release.open()
        let result = await launch.result
        guard case .failure(let error) = result else {
            Issue.record("the interrupted launch must fail")
            return
        }
        #expect((error as? NativeRuntimeError)?.code == "SHUTTING_DOWN")
        #expect(await supervisor.phase == .stopped)
        #expect(harness.spawner.spawns.filter { $0.executable.hasSuffix("/vision-backend") }.isEmpty)
        #expect(harness.spawner.spawns.count == 1)
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"] == nil)
    }

    @Test func logIsRotatedOnlyByTheInstanceHoldingTheLock() async throws {
        let harness = try Harness()
        harness.installSeed()
        let refusedLog = RecordingLog()
        let refused = makeSupervisor(harness, lock: FakeInstanceLock(heldElsewhere: true), log: refusedLog)
        await #expect(throws: NativeRuntimeError.self) { try await refused.launch() }
        #expect(refusedLog.rotations == 0)

        let log = RecordingLog()
        let supervisor = makeSupervisor(harness, log: log)
        _ = try await supervisor.launch()
        await supervisor.shutdown()
        _ = try await supervisor.launch()
        #expect(log.rotations == 1)
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

@Suite struct FileRuntimeLogTests {
    private func makeDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("vision-native-log-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func size(_ path: String) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.intValue ?? -1
    }

    @Test func secondInstanceLeavesTheFirstInstancesLogAlone() throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("main.log").path
        let large = Data(count: FileRuntimeLog.rotationThreshold + 1)
        try large.write(to: URL(fileURLWithPath: path))

        let second = FileRuntimeLog(path: path, rotate: false)
        second.log("log", "second instance")
        #expect(!FileManager.default.fileExists(atPath: path + ".1"))
        #expect(size(path) > FileRuntimeLog.rotationThreshold)

        // The instance that takes the lock rotates, then keeps writing to a fresh main.log.
        second.rotate()
        #expect(size(path + ".1") > FileRuntimeLog.rotationThreshold)
        second.log("log", "after rotation")
        let text = try String(contentsOfFile: path, encoding: .utf8)
        #expect(text.contains("after rotation"))
        #expect(size(path) < 4096)
    }

    @Test func rotatingConstructorRotatesALargeLog() throws {
        let directory = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("main.log").path
        try Data(count: FileRuntimeLog.rotationThreshold + 1).write(to: URL(fileURLWithPath: path))
        let log = FileRuntimeLog(path: path)
        log.log("log", "hello")
        #expect(FileManager.default.fileExists(atPath: path + ".1"))
        #expect(size(path) < 4096)
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
    }
}
