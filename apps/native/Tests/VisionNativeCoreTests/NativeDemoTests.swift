import Foundation
import Testing
@testable import VisionNativeCore

/// Records the calls Demo seeding makes, like the fake runtime in native-demo.test.ts. Its
/// activation copies the seed over the live database in the harness's file system.
final class FakeDemoRuntime: DemoSeedingRuntime, @unchecked Sendable {
    let layout: RuntimeLayout
    private let fileSystem: FakeFileSystem
    private let lock = NSLock()
    private var stateValue: [String: JSONValue]?
    private var recorded: [String] = []
    /// What `verifyDatabaseFile` reports after the backend started; `nil` reports the seed.
    var afterStart: (schemaVersion: Int, tableCounts: [String: Int]?)?
    /// Written over the live database instead of the seed (a corrupt activation).
    var activatedContent: Data?
    /// Replaces the default recovery, which clears both restore journals.
    var recoveryFailure: Error?
    let token = DatabaseSwitchToken(
        liveDirectory: "\(testUserData)/database", previousDirectory: "\(testUserData)/database.previous-1-aa",
        activatedDirectory: "\(testUserData)/database.restore-1-aa", activatedAt: "2026-10-12T00:00:00.000Z")

    init(layout: RuntimeLayout, fileSystem: FakeFileSystem, state: [String: JSONValue]? = nil) {
        self.layout = layout
        self.fileSystem = fileSystem
        stateValue = state
    }

    var events: [String] { lock.withLock { recorded } }
    var state: [String: JSONValue]? { lock.withLock { stateValue } }

    private func record(_ event: String) {
        lock.withLock { recorded.append(event) }
    }

    func ensureLayout() async throws { record("ensureLayout") }
    func discover() async throws { record("discover") }
    func readState() async throws -> [String: JSONValue]? { state }

    func writeState(set: [String: JSONValue], remove: [String]) async throws {
        lock.withLock {
            stateValue = RuntimeMarker.merged(
                current: stateValue, runtimeId: "vision_native", set: set, remove: remove,
                now: Date(timeIntervalSince1970: 0))
        }
        record("writeState")
    }

    func recoverInterruptedRestore() async throws {
        record("recoverInterruptedRestore")
        if let recoveryFailure { throw recoveryFailure }
        lock.withLock {
            _ = stateValue?.removeValue(forKey: "pendingDatabaseSwitch")
            _ = stateValue?.removeValue(forKey: "pendingAttachmentSwitch")
        }
    }

    func rollbackDatabaseSwitch(_ token: JSONValue?) async throws {
        record("rollback:\(token?["activatedDirectory"]?.stringValue.map(PathUtilities.basename) ?? "-")")
        lock.withLock { _ = stateValue?.removeValue(forKey: "pendingDatabaseSwitch") }
    }

    func activateRestoredDatabase(_ path: String, expectedSchemaVersion: Int?, expectedSha256: String?) async throws
        -> DatabaseActivation
    {
        record("activate:\(PathUtilities.basename(path)):\(expectedSchemaVersion.map(String.init) ?? "-")")
        let data = try activatedContent ?? fileSystem.readFile(path)
        fileSystem.addFile(layout.database, data)
        let report = DatabaseFileReport(
            file: layout.database, bytes: data.count, sha256: sha256Hex(data), sqliteVersion: "3.43.2",
            schemaVersion: expectedSchemaVersion ?? 0, pendingMigrations: 0)
        return DatabaseActivation(switchToken: token, validation: report)
    }

    func verifyDatabaseFile(_ path: String) async throws -> DatabaseFileReport {
        record("verify")
        let data = try fileSystem.readFile(path)
        let header = sqliteUserVersion(data) ?? 0
        return DatabaseFileReport(
            file: path, bytes: data.count, sha256: sha256Hex(data), sqliteVersion: "3.43.2",
            schemaVersion: afterStart?.schemaVersion ?? header, pendingMigrations: 0,
            tableCounts: afterStart.map { $0.tableCounts } ?? ["accounts": 3, "transactions": 40, "user_settings": 1])
    }

    func finalizeDatabaseSwitch(_ token: DatabaseSwitchToken) async throws { record("finalizeSwitch") }
    func stop() async throws { record("stop") }
}

private let fixedNow: @Sendable () -> Date = { Date(timeIntervalSince1970: 1_790_000_000) }

private func currentSeedMarker(_ seed: DemoSeed) -> JSONValue {
    .object([
        "logicalSha256": .string(seed.manifest.logicalSha256),
        "databaseSha256": .string(seed.manifest.databaseSha256),
        "schemaVersion": .int(seed.manifest.schemaVersion),
    ])
}

@Suite struct DemoSeedManifestTests {
    @Test func validManifestIsAccepted() throws {
        let harness = try Harness()
        let data = harness.installSeed()
        let seed = try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        #expect(seed.databasePath == "\(testSeedRoot)/vision-demo.sqlite3")
        #expect(seed.manifest.schemaVersion == 3)
        #expect(seed.manifest.databaseSha256 == sha256Hex(data))
        #expect(seed.manifest.databaseBytes == data.count)
        #expect(seed.manifest.tableCounts["transactions"] == 40)
    }

    @Test func inconsistentOrIncompleteManifestsAreRejected() {
        let digest = JSONValue.string(String(repeating: "a", count: 64))
        let base: [String: JSONValue] = [
            "version": .int(2), "format": .string("sqlite"), "logicalSha256": digest, "databaseSha256": digest,
            "databaseBytes": .int(4096), "schemaVersion": .int(3),
            "database": .object(["tableCounts": .object(["accounts": .int(1)])]),
        ]
        #expect(throws: Never.self) { try NativeDemo.validateManifest(.object(base)) }
        var changes: [(String, JSONValue)] = [
            ("version", .int(1)), ("format", .string("postgres")), ("databaseSha256", .string("nope")),
            ("databaseBytes", .int(0)), ("schemaVersion", .int(0)), ("schemaVersion", .string("0003_head")),
            ("database", .object(["tableCounts": .object([:])])),
            ("database", .object(["tableCounts": .object(["accounts": .int(-1)])])),
        ]
        changes.append(("logicalSha256", .null))
        for (key, value) in changes {
            var invalid = base
            invalid[key] = value
            let error = #expect(throws: NativeRuntimeError.self) { try NativeDemo.validateManifest(.object(invalid)) }
            #expect(error?.code == "DEMO_SEED_MANIFEST_INVALID")
        }
    }

    @Test func databaseChecksumIsVerified() throws {
        let harness = try Harness()
        harness.installSeed()
        harness.fileSystem.addFile("\(testSeedRoot)/vision-demo.sqlite3", sqliteDatabase(userVersion: 3, body: "x"))
        let error = #expect(throws: NativeRuntimeError.self) {
            try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        }
        #expect(error?.code == "DEMO_SEED_CHECKSUM_MISMATCH")
    }

    @Test func missingOrSymlinkedSeedIsRejected() throws {
        let harness = try Harness()
        let missing = #expect(throws: NativeRuntimeError.self) {
            try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        }
        #expect(missing?.code == "DEMO_SEED_MISSING")
        harness.installSeed()
        harness.fileSystem.addNode("\(testSeedRoot)/vision-demo.sqlite3", .symlink("/elsewhere.sqlite3"))
        let unsafe = #expect(throws: NativeRuntimeError.self) {
            try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        }
        #expect(unsafe?.code == "DEMO_SEED_UNSAFE")
    }
}

@Suite struct DemoSeedActivationTests {
    @Test func currentSeedIsNotRestoredAgain() async throws {
        let harness = try Harness()
        harness.installSeed()
        harness.installDatabase()
        let seed = try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        let runtime = FakeDemoRuntime(
            layout: harness.layout, fileSystem: harness.fileSystem,
            state: [
                "activeRuntime": .string("native"), "demoSeed": currentSeedMarker(seed),
                "demoSeedInProgress": .object([:]),
            ])
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(prepared.status == .current)
        #expect(prepared.switchToken == nil)
        #expect(!runtime.events.contains { $0.hasPrefix("activate") })
        #expect(runtime.state?["demoSeedInProgress"] == nil)
        #expect(runtime.state?["activation"] == .string("demo-native"))
    }

    @Test func aCurrentMarkerWithoutADatabaseFileReseeds() async throws {
        let harness = try Harness()
        harness.installSeed()
        let seed = try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        let runtime = FakeDemoRuntime(
            layout: harness.layout, fileSystem: harness.fileSystem, state: ["demoSeed": currentSeedMarker(seed)])
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(prepared.status == .activated)
    }

    @Test func newSeedIsActivatedThenVerifiedAndFinalizedAfterStart() async throws {
        let harness = try Harness()
        harness.installSeed()
        let runtime = FakeDemoRuntime(layout: harness.layout, fileSystem: harness.fileSystem)
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(prepared.status == .activated)
        #expect(prepared.switchToken == runtime.token)
        #expect(runtime.state?["demoSeedInProgress"]?["schemaVersion"] == .int(3))
        #expect(runtime.state?["demoSeedInProgress"]?["databaseSha256"] == .string(prepared.manifest.databaseSha256))
        #expect(
            runtime.events == [
                "ensureLayout", "discover", "recoverInterruptedRestore", "writeState", "activate:vision-demo.sqlite3:3",
            ])

        let warning = try await NativeDemo.finalize(
            runtime: runtime, prepared: prepared, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(warning == nil)
        #expect(runtime.events.suffix(3) == ["verify", "finalizeSwitch", "writeState"])
        #expect(runtime.state?["demoSeed"]?["logicalSha256"] == .string(prepared.manifest.logicalSha256))
        #expect(runtime.state?["demoSeed"]?["appliedAt"] != nil)
        #expect(runtime.state?["demoSeedInProgress"] == nil)
    }

    @Test func anActivatedDatabaseThatDiffersFromTheSeedIsRolledBack() async throws {
        let harness = try Harness()
        harness.installSeed()
        let runtime = FakeDemoRuntime(layout: harness.layout, fileSystem: harness.fileSystem)
        runtime.activatedContent = sqliteDatabase(userVersion: 3, body: "something else")
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await NativeDemo.prepare(
                runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        }
        #expect(error?.code == "DEMO_SEED_CHECKSUM_MISMATCH")
        #expect(runtime.events.last == "rollback:database.restore-1-aa")
    }

    @Test func aMigratedSeedIsAcceptedWhileStableRowsStayTheSame() async throws {
        let harness = try Harness()
        harness.installSeed(schemaVersion: 2)
        let runtime = FakeDemoRuntime(layout: harness.layout, fileSystem: harness.fileSystem)
        // The backend migrated 2 → 3 and wrote its own settings rows on start.
        runtime.afterStart = (3, ["accounts": 3, "transactions": 40, "user_settings": 7])
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        _ = try await NativeDemo.finalize(
            runtime: runtime, prepared: prepared, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(runtime.events.contains("finalizeSwitch"))
    }

    @Test(arguments: [
        (2, ["accounts": 3, "transactions": 40, "user_settings": 1], "DATABASE_SCHEMA_MISMATCH"),
        (3, ["accounts": 4, "transactions": 40, "user_settings": 1], "DATABASE_COUNT_MISMATCH"),
    ] as [(Int, [String: Int], String)])
    func driftAfterStartFailsFinalization(_ schemaVersion: Int, _ counts: [String: Int], _ code: String)
        async throws
    {
        let harness = try Harness()
        harness.installSeed()
        let runtime = FakeDemoRuntime(layout: harness.layout, fileSystem: harness.fileSystem)
        runtime.afterStart = (schemaVersion, counts)
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await NativeDemo.finalize(
                runtime: runtime, prepared: prepared, fileSystem: harness.fileSystem, now: fixedNow)
        }
        #expect(error?.code == code)
        #expect(!runtime.events.contains("finalizeSwitch"))
    }

    /// native-demo.test.ts: paired journals are recovered before a current seed is trusted.
    @Test func pairedRestoreJournalsAreRecoveredBeforeTrustingACurrentSeed() async throws {
        let harness = try Harness()
        harness.installSeed()
        harness.installDatabase()
        let seed = try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        let runtime = FakeDemoRuntime(
            layout: harness.layout, fileSystem: harness.fileSystem,
            state: [
                "pendingDatabaseSwitch": .object(["previousDirectory": .string("database.previous")]),
                "pendingAttachmentSwitch": .object(["previousDirectory": .string("attachments.previous")]),
                "demoSeed": currentSeedMarker(seed),
            ])
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(prepared.status == .current)
        #expect(runtime.state?["pendingDatabaseSwitch"] == nil)
        #expect(runtime.state?["pendingAttachmentSwitch"] == nil)
        let events = runtime.events
        let recovered = try #require(events.firstIndex(of: "recoverInterruptedRestore"))
        let firstWrite = try #require(events.firstIndex(of: "writeState"))
        #expect(firstWrite > recovered)
        #expect(!events.contains { $0.hasPrefix("rollback") || $0.hasPrefix("activate") })
    }

    /// native-demo.test.ts: a failed coordinated recovery stops the preparation before
    /// any write, rollback or seed restore.
    @Test func aFailedCoordinatedRecoveryStopsDemoPreparation() async throws {
        let harness = try Harness()
        harness.installSeed()
        let journals: [String: JSONValue] = [
            "pendingDatabaseSwitch": .object(["previousDirectory": .string("database.previous")]),
            "pendingAttachmentSwitch": .object(["previousDirectory": .string("attachments.previous")]),
        ]
        let runtime = FakeDemoRuntime(layout: harness.layout, fileSystem: harness.fileSystem, state: journals)
        runtime.recoveryFailure = NativeRuntimeError("SYNTHETIC", "Synthetic recovery failure")
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await NativeDemo.prepare(
                runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        }
        #expect(error?.code == "SYNTHETIC")
        #expect(runtime.state == journals)
        #expect(!runtime.events.contains("writeState"))
        #expect(!runtime.events.contains { $0.hasPrefix("rollback") || $0.hasPrefix("activate") })
    }

    @Test func rollbackRestoresThePreviousSeedMarker() async throws {
        let harness = try Harness()
        harness.installSeed()
        let previous = JSONValue.object(["logicalSha256": .string("old"), "schemaVersion": .int(2)])
        let runtime = FakeDemoRuntime(
            layout: harness.layout, fileSystem: harness.fileSystem, state: ["demoSeed": previous])
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        try await NativeDemo.rollback(runtime: runtime, prepared: prepared, now: fixedNow)
        #expect(runtime.events.contains("stop"))
        #expect(runtime.events.contains("rollback:database.restore-1-aa"))
        #expect(runtime.state?["demoSeed"] == previous)
        #expect(runtime.state?["demoSeedInProgress"] == nil)
        #expect(runtime.state?["lastDemoSeedFailureAt"] != nil)
    }
}

@Suite struct DemoResetRequestTests {
    @Test func resetRequestForcesARestoreAndIsRemovedOnlyAfterFinalize() async throws {
        let harness = try Harness()
        harness.installSeed()
        harness.installDatabase()
        let seed = try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        try NativeDemo.requestReset(harness.layout, fileSystem: harness.fileSystem, now: fixedNow())
        #expect(try harness.fileSystem.mode(harness.layout.demoResetRequest) == 0o600)
        let runtime = FakeDemoRuntime(
            layout: harness.layout, fileSystem: harness.fileSystem, state: ["demoSeed": currentSeedMarker(seed)])
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(prepared.status == .activated)
        #expect(prepared.resetRequested)
        #expect(harness.fileSystem.exists(harness.layout.demoResetRequest))
        _ = try await NativeDemo.finalize(
            runtime: runtime, prepared: prepared, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(!harness.fileSystem.exists(harness.layout.demoResetRequest))
    }

    @Test func unsafeResetRequestsAreRefused() throws {
        for node: FakeFileSystem.Node in [.symlink("/etc/passwd"), .fifo, .directory(0o700)] {
            let harness = try Harness()
            harness.fileSystem.addNode(harness.layout.demoResetRequest, node)
            let error = #expect(throws: NativeRuntimeError.self) {
                try NativeDemo.hasResetRequest(harness.layout, fileSystem: harness.fileSystem)
            }
            #expect(error?.code == "DEMO_RESET_UNSAFE")
        }
    }

    @Test func invalidResetRequestIsRefused() throws {
        let harness = try Harness()
        harness.fileSystem.addFile(harness.layout.demoResetRequest, #"{"version":2}"#)
        let error = #expect(throws: NativeRuntimeError.self) {
            try NativeDemo.hasResetRequest(harness.layout, fileSystem: harness.fileSystem)
        }
        #expect(error?.code == "DEMO_RESET_INVALID")
        #expect(try !NativeDemo.hasResetRequest(Harness().layout, fileSystem: FakeFileSystem()))
    }

    @Test func seedingRefusesAnyOtherRuntime() throws {
        let foreign = try RuntimeLayout(userDataDirectory: testUserData, runtimeId: "vision_demo")
        let error = #expect(throws: NativeRuntimeError.self) { try NativeDemo.assertIsolation(foreign) }
        #expect(error?.code == "DEMO_RUNTIME_UNSAFE")
        #expect(throws: NativeRuntimeError.self) {
            try RuntimeLayout(userDataDirectory: "/Users/demo/Library/Application Support/Vision Demo")
        }
    }
}

@Suite struct DemoSeedRuntimeIntegrationTests {
    @Test func nativeRuntimeSwapsInTheSeedAndKeepsThePreviousGeneration() async throws {
        let harness = try Harness()
        let seedData = harness.installSeed()
        let old = harness.installDatabase(body: "user data")
        let runtime = try harness.makeRuntime()
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        let token = try #require(prepared.switchToken)
        #expect(token.liveDirectory == harness.layout.databaseDirectory)
        #expect(try harness.fileSystem.readFile(harness.layout.database) == seedData)
        #expect(try harness.fileSystem.readFile("\(token.previousDirectory)/vision.sqlite3") == old)
        #expect(harness.toolCommands.first?.first == "verify")
        #expect(harness.fileSystem.json(harness.layout.state)?["pendingDatabaseSwitch"] != nil)

        _ = try await NativeDemo.finalize(
            runtime: runtime, prepared: prepared, fileSystem: harness.fileSystem, now: fixedNow)
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"] == nil)
        #expect(state["previousDatabase"] == .string(token.previousDirectory))
        #expect(state["demoSeed"]?["schemaVersion"] == .int(3))
    }

    @Test func nativeRuntimeRollbackRestoresThePreviousDatabase() async throws {
        let harness = try Harness()
        harness.installSeed()
        let old = harness.installDatabase(body: "user data")
        let runtime = try harness.makeRuntime()
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        let token = try #require(prepared.switchToken)
        try await NativeDemo.rollback(runtime: runtime, prepared: prepared, now: fixedNow)
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"] == nil)
        #expect(state["lastRollback"]?["restoredDatabase"] == .string(token.previousDirectory))
        #expect(state["lastRollback"]?["preservedFailedDatabase"] != nil)
        #expect(try harness.fileSystem.readFile(harness.layout.database) == old)
    }
}
