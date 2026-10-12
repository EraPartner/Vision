import Foundation
import Testing
@testable import VisionNativeCore

/// Records the calls Demo seeding makes, like the fake runtime in native-demo.test.ts.
final class FakeDemoRuntime: DemoSeedingRuntime, @unchecked Sendable {
    let layout: RuntimeLayout
    private let lock = NSLock()
    private var stateValue: [String: JSONValue]?
    private var recorded: [String] = []
    var stats: DatabaseStats
    var statsAfterStart: DatabaseStats?
    private var statsReads = 0
    let token = DatabaseSwitchToken(
        version: 1, liveDatabase: "vision_native", previousDatabase: "vision_native_previous_aaaaaaaaaa",
        activatedDatabase: "vision_native_restore_bbbbbbbbbb", activatedAt: "2026-10-12T00:00:00.000Z")

    init(layout: RuntimeLayout, state: [String: JSONValue]? = nil, stats: DatabaseStats) {
        self.layout = layout
        stateValue = state
        self.stats = stats
    }

    var events: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    var state: [String: JSONValue]? {
        lock.lock()
        defer { lock.unlock() }
        return stateValue
    }

    private func record(_ event: String) {
        lock.lock()
        recorded.append(event)
        lock.unlock()
    }

    func ensureLayout() async throws { record("ensureLayout") }
    func discover() async throws { record("discover") }
    func readState() async throws -> [String: JSONValue]? { state }

    func writeState(set: [String: JSONValue], remove: [String]) async throws {
        lock.lock()
        stateValue = RuntimeMarker.merged(
            current: stateValue, runtimeId: "vision_native", set: set, remove: remove,
            now: Date(timeIntervalSince1970: 0))
        lock.unlock()
        record("writeState")
    }

    func ensurePostgresReady() async throws { record("ensurePostgresReady") }

    func rollbackDatabaseSwitch(_ token: JSONValue?) async throws {
        record("rollback:\(token?["activatedDatabase"]?.stringValue ?? "-")")
        lock.lock()
        stateValue?.removeValue(forKey: "pendingDatabaseSwitch")
        lock.unlock()
    }

    func validateCustomDump(_ path: String) async throws { record("validate:\(PathUtilities.basename(path))") }

    func activateRestoredDatabase(_ path: String, expectedSchemaHead: String) async throws -> DatabaseSwitchToken {
        record("activate:\(expectedSchemaHead)")
        return token
    }

    func getDatabaseStats() async throws -> DatabaseStats {
        lock.lock()
        statsReads += 1
        let result = statsReads > 1 ? (statsAfterStart ?? stats) : stats
        lock.unlock()
        record("stats")
        return result
    }

    func finalizeDatabaseSwitch(_ token: DatabaseSwitchToken) async throws { record("finalizeSwitch") }
    func stop(keepPostgres: Bool) async throws { record("stop:\(keepPostgres)") }
}

private func seedStats(_ counts: [String: Int] = ["accounts": 3, "transactions": 40], schema: String = "0130_head")
    -> DatabaseStats
{
    DatabaseStats(
        schema: schema, postgresVersionNum: 180_006, tableCounts: counts, stableImportantRowCounts: ["user_settings": 0])
}

private let fixedNow: @Sendable () -> Date = { Date(timeIntervalSince1970: 1_790_000_000) }

@Suite struct DemoSeedManifestTests {
    @Test func validManifestIsAccepted() throws {
        let harness = try Harness()
        harness.installSeed()
        let seed = try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        #expect(seed.manifest.schemaRevision == "0130_head")
        #expect(seed.dumpPath == "\(testSeedRoot)/demo-seed.dump")
        #expect(seed.manifest.database.tableCounts?["transactions"] == .int(40))
    }

    @Test func inconsistentOrIncompleteManifestsAreRejected() {
        let digest = JSONValue.string(String(repeating: "a", count: 64))
        let base: [String: JSONValue] = [
            "version": .int(1), "logicalSha256": digest, "dumpSha256": digest, "schemaRevision": .string("0130_head"),
            "database": .object(["schema": .string("0130_head"), "tableCounts": .object(["accounts": .int(1)])]),
        ]
        #expect(throws: Never.self) { try NativeDemo.validateManifest(.object(base)) }
        var wrongSchema = base
        wrongSchema["database"] = .object([
            "schema": .string("0129_old"), "tableCounts": .object(["accounts": .int(1)]),
        ])
        var noTables = base
        noTables["database"] = .object(["schema": .string("0130_head"), "tableCounts": .object([:])])
        var badDigest = base
        badDigest["dumpSha256"] = .string("nope")
        var wrongVersion = base
        wrongVersion["version"] = .int(2)
        for invalid in [wrongSchema, noTables, badDigest, wrongVersion] {
            #expect(throws: NativeRuntimeError.self) { try NativeDemo.validateManifest(.object(invalid)) }
        }
    }

    @Test func dumpChecksumIsVerified() throws {
        let harness = try Harness()
        harness.installSeed()
        harness.fileSystem.addFile("\(testSeedRoot)/demo-seed.dump", "PGDMP tampered")
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
        harness.fileSystem.addNode("\(testSeedRoot)/demo-seed.dump", .symlink("/elsewhere.dump"))
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
        let seed = try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        let runtime = FakeDemoRuntime(
            layout: harness.layout,
            state: [
                "activeRuntime": .string("native"),
                "demoSeed": .object([
                    "logicalSha256": .string(seed.manifest.logicalSha256),
                    "schemaRevision": .string(seed.manifest.schemaRevision),
                ]),
                "demoSeedInProgress": .object([:]),
            ],
            stats: seedStats())
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(prepared.status == .current)
        #expect(prepared.switchToken == nil)
        #expect(!runtime.events.contains { $0.hasPrefix("activate") || $0.hasPrefix("validate") })
        #expect(runtime.state?["demoSeedInProgress"] == nil)
        #expect(runtime.state?["activation"] == .string("demo-native"))
    }

    @Test func newSeedIsRestoredVerifiedAndFinalized() async throws {
        let harness = try Harness()
        harness.installSeed()
        let runtime = FakeDemoRuntime(layout: harness.layout, stats: seedStats())
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(prepared.status == .activated)
        #expect(prepared.switchToken == runtime.token)
        #expect(runtime.state?["demoSeedInProgress"]?["schemaRevision"] == .string("0130_head"))
        #expect(
            runtime.events == [
                "ensureLayout", "discover", "writeState", "validate:demo-seed.dump", "activate:0130_head", "stats",
            ])

        let warning = try await NativeDemo.finalize(
            runtime: runtime, prepared: prepared, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(warning == nil)
        #expect(runtime.events.suffix(3) == ["stats", "finalizeSwitch", "writeState"])
        #expect(runtime.state?["demoSeed"]?["logicalSha256"] == .string(prepared.manifest.logicalSha256))
        #expect(runtime.state?["demoSeedInProgress"] == nil)
    }

    @Test func countMismatchRollsTheSwitchBack() async throws {
        let harness = try Harness()
        harness.installSeed()
        let runtime = FakeDemoRuntime(
            layout: harness.layout, stats: seedStats(["accounts": 3, "transactions": 39]))
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await NativeDemo.prepare(
                runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        }
        #expect(error?.code == "DATABASE_COUNT_MISMATCH")
        #expect(runtime.events.last == "rollback:\(runtime.token.activatedDatabase)")
    }

    @Test func driftAfterStartFailsFinalization() async throws {
        let harness = try Harness()
        harness.installSeed()
        let runtime = FakeDemoRuntime(layout: harness.layout, stats: seedStats())
        runtime.statsAfterStart = seedStats(["accounts": 4, "transactions": 40])
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        await #expect(throws: NativeRuntimeError.self) {
            try await NativeDemo.finalize(
                runtime: runtime, prepared: prepared, fileSystem: harness.fileSystem, now: fixedNow)
        }
        #expect(!runtime.events.contains("finalizeSwitch"))
    }

    @Test func interruptedSwitchIsRolledBackFirst() async throws {
        let harness = try Harness()
        harness.installSeed()
        let pending = JSONValue.object(["liveDatabase": .string("vision_native"), "activatedDatabase": .string("x")])
        let runtime = FakeDemoRuntime(
            layout: harness.layout, state: ["pendingDatabaseSwitch": pending], stats: seedStats())
        _ = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        #expect(Array(runtime.events.prefix(4)) == ["ensureLayout", "discover", "ensurePostgresReady", "rollback:x"])
    }

    @Test func rollbackRestoresThePreviousSeedMarker() async throws {
        let harness = try Harness()
        harness.installSeed()
        let previous = JSONValue.object(["logicalSha256": .string("old"), "schemaRevision": .string("0129_old")])
        let runtime = FakeDemoRuntime(layout: harness.layout, state: ["demoSeed": previous], stats: seedStats())
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        try await NativeDemo.rollback(runtime: runtime, prepared: prepared, now: fixedNow)
        #expect(runtime.events.contains("stop:true"))
        #expect(runtime.events.contains("rollback:\(runtime.token.activatedDatabase)"))
        #expect(runtime.state?["demoSeed"] == previous)
        #expect(runtime.state?["demoSeedInProgress"] == nil)
        #expect(runtime.state?["lastDemoSeedFailureAt"] != nil)
    }
}

@Suite struct DemoResetRequestTests {
    @Test func resetRequestForcesARestoreAndIsRemovedOnlyAfterFinalize() async throws {
        let harness = try Harness()
        harness.installSeed()
        let seed = try NativeDemo.loadSeed(seedRoot: testSeedRoot, fileSystem: harness.fileSystem)
        try NativeDemo.requestReset(harness.layout, fileSystem: harness.fileSystem, now: fixedNow())
        #expect(try harness.fileSystem.mode(harness.layout.demoResetRequest) == 0o600)
        let runtime = FakeDemoRuntime(
            layout: harness.layout,
            state: [
                "demoSeed": .object([
                    "logicalSha256": .string(seed.manifest.logicalSha256),
                    "schemaRevision": .string(seed.manifest.schemaRevision),
                ])
            ],
            stats: seedStats())
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
    @Test func nativeRuntimeSwapsInTheRestoredDatabaseAndKeepsThePrevious() async throws {
        let harness = try Harness()
        harness.installSeed()
        let runtime = try harness.makeRuntime()
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        let token = try #require(prepared.switchToken)
        #expect(token.liveDatabase == "vision_native")
        #expect(harness.databases.contains("vision_native"))
        #expect(harness.databases.contains(token.previousDatabase))
        #expect(!harness.databases.contains(token.activatedDatabase))
        let pgRestore = try #require(harness.runner.calls(named: "pg_restore").last)
        #expect(pgRestore.arguments.contains("--single-transaction"))
        #expect(pgRestore.arguments.contains("vision_native_owner"))
        #expect(harness.fileSystem.json(harness.layout.state)?["pendingDatabaseSwitch"] != nil)

        _ = try await NativeDemo.finalize(
            runtime: runtime, prepared: prepared, fileSystem: harness.fileSystem, now: fixedNow)
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"] == nil)
        #expect(state["previousDatabase"] == .string(token.previousDatabase))
        #expect(state["demoSeed"]?["schemaRevision"] == .string("0130_head"))
    }

    @Test func nativeRuntimeRollbackRestoresThePreviousDatabase() async throws {
        let harness = try Harness()
        harness.installSeed()
        let runtime = try harness.makeRuntime()
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: testSeedRoot, fileSystem: harness.fileSystem, now: fixedNow)
        let token = try #require(prepared.switchToken)
        try await NativeDemo.rollback(runtime: runtime, prepared: prepared, now: fixedNow)
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"] == nil)
        #expect(state["lastRollback"]?["restoredDatabase"] == .string(token.previousDatabase))
        let failed = try #require(state["lastRollback"]?["preservedFailedDatabase"]?.stringValue)
        #expect(harness.databases == ["vision_native", failed])
    }
}
