import Foundation
import Testing
@testable import VisionNativeCore

// The runtime side of backup and restore: pg_dump, the Kysely schema head and a plain-SQL
// restore into a staging database.

private let schemaHeadQuery = MigrationLedger.headSQL

private func backupHarness(dumpContent: String = "-- dump\n") throws -> Harness {
    let harness = try Harness()
    let base = harness.runner.handler
    let fileSystem = harness.fileSystem
    harness.runner.handler = { call in
        if call.name == "pg_dump", let index = call.arguments.firstIndex(of: "--file") {
            fileSystem.addFile(call.arguments[index + 1], dumpContent)
            return RunResult()
        }
        return try base(call)
    }
    return harness
}

@Suite struct NativeRuntimeBackupTests {
    @Test func theSchemaHeadIsTheHighestLedgerName() async throws {
        let harness = try backupHarness()
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        let head = try await runtime.schemaHead()
        #expect(head == "0130_head")
        let call = try #require(harness.runner.calls(named: "psql").first { $0.arguments.contains(schemaHeadQuery) })
        #expect(call.arguments.contains("vision_native_owner"))
        #expect(call.options.environment["PGPASSFILE"] != nil)
        // The ledger is checked first so a database without it reads as empty, not as an error.
        let exists = harness.runner.calls(named: "psql").contains {
            $0.arguments.contains(MigrationLedger.ledgerExistsSQL)
        }
        #expect(exists)
    }

    @Test func aDatabaseWithoutALedgerHasNoSchemaHead() async throws {
        let harness = try backupHarness()
        harness.ledger = nil
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        #expect(try await runtime.schemaHead() == "")
        #expect(try await runtime.appliedMigrations() == [])
        #expect(try await runtime.pendingMigrations() == nil)
    }

    @Test func appliedMigrationsListTheLedger() async throws {
        let harness = try backupHarness()
        harness.ledger = ["0130_head", "0001_baseline"]
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        #expect(try await runtime.appliedMigrations() == ["0001_baseline", "0130_head"])
    }

    @Test func pendingMigrationsNeedAnExistingDatabaseBehindThePayload() async throws {
        let harness = try backupHarness()
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        // The ledger ends at the payload's newest migration (0130_head): nothing is pending.
        #expect(try await runtime.pendingMigrations() == nil)
        harness.ledger = ["0001_baseline"]
        #expect(
            try await runtime.pendingMigrations()
                == PendingMigrations(appliedHead: "0001_baseline", packagedHead: "0130_head"))
        // A database from a newer build is not "behind" the payload.
        harness.ledger = ["0131_future"]
        #expect(try await runtime.pendingMigrations() == nil)
    }

    @Test func dumpsPlainSqlAsTheOwnerIntoAPrivateFile() async throws {
        let harness = try backupHarness()
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        try await runtime.dumpDatabase(to: "/tmp/vision_bak_1/db.sql")

        #expect(harness.fileSystem.text("/tmp/vision_bak_1/db.sql") == "-- dump\n")
        #expect(try harness.fileSystem.mode("/tmp/vision_bak_1/db.sql") == 0o600)
        #expect(harness.fileSystem.node("/tmp/vision_bak_1/db.sql.partial") == nil)
        // Tool discovery probes each binary with `--version` first; skip the probe.
        let dump = try #require(harness.runner.calls(named: "pg_dump").first { $0.arguments != ["--version"] })
        for flag in ["--no-owner", "--no-acl", "--no-comments", "--format=plain"] {
            #expect(dump.arguments.contains(flag))
        }
        #expect(
            dump.arguments.filter { $0 == "--exclude-extension" }.count
                == RuntimeConstants.requiredPostgresExtensions.count)
        let user = dump.arguments.firstIndex(of: "-U").map { dump.arguments[$0 + 1] }
        #expect(user == "vision_native_owner")
        #expect(dump.arguments.last == "/tmp/vision_bak_1/db.sql.partial")
    }

    @Test func anEmptyDumpFails() async throws {
        let harness = try backupHarness(dumpContent: "")
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        do {
            try await runtime.dumpDatabase(to: "/tmp/vision_bak_2/db.sql")
            Issue.record("an empty dump was accepted")
        } catch let error as NativeRuntimeError {
            #expect(error.code == "POSTGRES_DUMP_EMPTY")
        }
        #expect(harness.fileSystem.node("/tmp/vision_bak_2/db.sql") == nil)
        #expect(harness.fileSystem.node("/tmp/vision_bak_2/db.sql.partial") == nil)
    }

    @Test func aPlainDumpIsRestoredWithPsqlInOneTransaction() async throws {
        let harness = try backupHarness()
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        harness.fileSystem.addFile("/tmp/vision_restore_1/db.sql", "CREATE TABLE t (id integer);\n")

        let token = try await runtime.activateRestoredDatabase(
            "/tmp/vision_restore_1/db.sql", format: .plain, expectedSchemaHead: "0130_head")
        #expect(token.liveDatabase == "vision_native")
        #expect(harness.databases.contains("vision_native"))
        #expect(harness.databases.contains(token.previousDatabase))
        #expect(harness.runner.calls(named: "pg_restore").allSatisfy { $0.arguments == ["--version"] })
        let restore = try #require(
            harness.runner.calls(named: "psql").first { $0.arguments.contains("/tmp/vision_restore_1/db.sql") })
        #expect(restore.arguments.contains("--single-transaction"))
        #expect(restore.arguments.contains("ON_ERROR_STOP=1"))
        // The staging database is validated against the ledger before it can become live.
        let ledgerChecks = harness.runner.calls(named: "psql").filter {
            $0.arguments.contains(MigrationLedger.headSQL)
        }
        #expect(ledgerChecks.contains { $0.arguments.contains(token.activatedDatabase) })
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"]?["previousDatabase"] == .string(token.previousDatabase))
    }

    @Test func aRestoredDatabaseWithoutTheLedgerIsRefusedAsPreBaseline() async throws {
        let harness = try backupHarness()
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        harness.fileSystem.addFile("/tmp/vision_restore_2/db.sql", "CREATE TABLE t (id integer);\n")
        harness.ledger = nil
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await runtime.activateRestoredDatabase(
                "/tmp/vision_restore_2/db.sql", format: .plain, expectedSchemaHead: "0130_head")
        }
        #expect(error?.code == "BACKUP_PRE_BASELINE")
        // Nothing was switched: the live database stays and no switch plan was persisted.
        #expect(harness.databases == ["vision_native"])
        #expect(harness.fileSystem.json(harness.layout.state)?["pendingDatabaseSwitch"] == nil)
    }

    @Test func aRestoredLedgerThatDisagreesWithTheBackupIsRefused() async throws {
        let harness = try backupHarness()
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        harness.fileSystem.addFile("/tmp/vision_restore_3/db.sql", "CREATE TABLE t (id integer);\n")
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await runtime.activateRestoredDatabase(
                "/tmp/vision_restore_3/db.sql", format: .plain, expectedSchemaHead: "0129_prev")
        }
        #expect(error?.code == "RESTORE_VALIDATION_FAILED")
        #expect(harness.databases == ["vision_native"])
    }
}

/// ADR-242: the backup hook runs after PostgreSQL is ready and before the backend, which
/// migrates at boot, is spawned.
@Suite struct NativePreMigrationBackupTests {
    private func backendSpawns(_ harness: Harness) -> Int {
        harness.spawner.spawns.filter { $0.executable.hasSuffix("vision-backend") }.count
    }

    @Test func theHookRunsBeforeTheBackendSpawnsWhenTheDatabaseIsBehind() async throws {
        let harness = try Harness()
        harness.ledger = ["0001_baseline"]
        let seen = LockedValue<[PendingMigrations]>([])
        let backendsAtHook = LockedValue<Int>(-1)
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start(beforeMigrations: { pending in
            seen.withLock { $0.append(pending) }
            backendsAtHook.withLock { $0 = harness.spawner.spawns.filter { $0.executable.hasSuffix("vision-backend") }.count }
        })
        #expect(seen.withLock { $0 } == [PendingMigrations(appliedHead: "0001_baseline", packagedHead: "0130_head")])
        #expect(backendsAtHook.withLock { $0 } == 0)
        #expect(backendSpawns(harness) == 1)
    }

    @Test func aFailingHookAbortsTheStartWithoutABackend() async throws {
        let harness = try Harness()
        harness.ledger = ["0001_baseline"]
        let runtime = try harness.makeRuntime()
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await runtime.start(beforeMigrations: { _ in
                throw NativeRuntimeError("PRE_MIGRATION_BACKUP_FAILED", "disk full")
            })
        }
        #expect(error?.code == "PRE_MIGRATION_BACKUP_FAILED")
        #expect(backendSpawns(harness) == 0)
        #expect(!harness.fileSystem.exists(harness.layout.pid))
    }

    @Test(arguments: [nil, ["0130_head"], ["0131_future"]] as [[String]?])
    func theHookIsSkippedForNewUpToDateOrNewerDatabases(_ ledger: [String]?) async throws {
        let harness = try Harness()
        harness.ledger = ledger
        let calls = LockedValue<Int>(0)
        _ = try await harness.makeRuntime().start(beforeMigrations: { _ in calls.withLock { $0 += 1 } })
        #expect(calls.withLock { $0 } == 0)
        #expect(backendSpawns(harness) == 1)
    }

    @Test func noHookMeansNoCheck() async throws {
        let harness = try Harness()
        harness.ledger = ["0001_baseline"]
        _ = try await harness.makeRuntime().start()
        #expect(backendSpawns(harness) == 1)
    }

    @Test func theLaunchTimesThePayloadVerification() async throws {
        let harness = try Harness()
        let phases = LockedValue<[String]>([])
        let runtime = try NativeRuntime(
            layout: harness.layout, runtimeRoot: testRuntimeRoot, appPort: 41_000,
            inheritedEnvironment: ["PATH": "/usr/bin", "HOME": testHome], dependencies: harness.dependencies,
            recordBootPhase: { phase, _ in phases.withLock { $0.append(phase) } })
        _ = try await runtime.start()
        #expect(phases.withLock { $0 } == ["runtime_manifest_full"])
        try await runtime.stop(keepPostgres: false)

        let again = try NativeRuntime(
            layout: harness.layout, runtimeRoot: testRuntimeRoot, appPort: 41_000,
            inheritedEnvironment: ["PATH": "/usr/bin", "HOME": testHome], dependencies: harness.dependencies,
            recordBootPhase: { phase, _ in phases.withLock { $0.append(phase) } })
        _ = try await again.start()
        #expect(phases.withLock { $0 } == ["runtime_manifest_full", "runtime_manifest_cached"])
    }
}

/// A runtime whose attachments live on the real file system below a temporary
/// "Vision Native" directory; its state marker stays in the harness's fake file system.
private struct AttachmentRuntime {
    let root: String
    let harness: Harness
    let layout: RuntimeLayout
    let runtime: NativeRuntime

    init() throws {
        root = try makeBackupScratchDirectory()
        harness = try Harness()
        layout = try RuntimeLayout(userDataDirectory: root + "/Vision Native")
        runtime = try NativeRuntime(
            layout: layout, runtimeRoot: testRuntimeRoot, appPort: 41_000, inheritedEnvironment: [:],
            dependencies: harness.dependencies)
    }

    func makeTree(_ directory: String, _ files: [String: String]) throws {
        for (name, content) in files {
            let path = directory + "/" + name
            try BackupFiles.createDirectory(PathUtilities.dirname(path))
            try writeBytes(path, Array(content.utf8))
        }
    }

    func pending() -> JSONValue? {
        harness.fileSystem.json(layout.state)?["pendingAttachmentSwitch"]
    }

    func remove() {
        try? FileManager.default.removeItem(atPath: root)
    }
}

@Suite struct NativeRuntimeAttachmentSwitchTests {
    @Test func theMigrationChainHeadComesFromThePayload() async throws {
        let harness = try Harness(payload: false)
        let runtime = try harness.makeRuntime()
        let empty = await runtime.migrationChainHead()
        #expect(empty == "")
        for name in [
            "0129_prev.sql", "0130_head.sql", "0131_undo.down.sql", "0132_notes.txt", "_0999_hidden.sql", "readme.sql",
            "0133_Upper.sql",
        ] {
            harness.fileSystem.addFile("\(testRuntimeRoot)/db/migrations/\(name)", "-- migration\n")
        }
        let head = await runtime.migrationChainHead()
        #expect(head == "0130_head")
    }

    @Test func replaceFinalizePersistsAndClearsTheToken() async throws {
        let fixture = try AttachmentRuntime()
        defer { fixture.remove() }
        let live = fixture.layout.attachments
        try fixture.makeTree(live, ["old/a.txt": "old"])
        try fixture.makeTree(fixture.root + "/restored", ["new/b.txt": "new"])

        let token = try await fixture.runtime.replaceAttachments(from: fixture.root + "/restored")
        #expect(BackupFiles.exists(live + "/new/b.txt"))
        #expect(!BackupFiles.exists(live + "/old/a.txt"))
        let previous = try #require(token.previousDirectory)
        #expect(BackupFiles.exists(previous + "/old/a.txt"))
        let stored = fixture.pending()
        #expect(try stored?.decode(DirectorySwitchToken.self) == token)

        try await fixture.runtime.finalizeAttachmentSwitch(token)
        #expect(!BackupFiles.exists(previous))
        #expect(BackupFiles.exists(live + "/new/b.txt"))
        #expect(fixture.pending() == nil)
    }

    @Test func rollbackUsesThePersistedTokenAndClearsIt() async throws {
        let fixture = try AttachmentRuntime()
        defer { fixture.remove() }
        let live = fixture.layout.attachments
        try fixture.makeTree(live, ["old/a.txt": "old"])
        try fixture.makeTree(fixture.root + "/restored", ["new/b.txt": "new"])
        _ = try await fixture.runtime.replaceAttachments(from: fixture.root + "/restored")

        try await fixture.runtime.rollbackPendingAttachmentSwitch()
        #expect(BackupFiles.exists(live + "/old/a.txt"))
        #expect(!BackupFiles.exists(live + "/new/b.txt"))
        #expect(fixture.pending() == nil)
        let siblings = try FileManager.default.contentsOfDirectory(atPath: PathUtilities.dirname(live))
        #expect(siblings.contains { $0.hasPrefix("attachments.failed-") })
    }

    @Test func launchRecoveryRollsBackWhileTheDatabaseSwitchIsPending() async throws {
        let fixture = try AttachmentRuntime()
        defer { fixture.remove() }
        let live = fixture.layout.attachments
        try fixture.makeTree(live, ["old/a.txt": "old"])
        try fixture.makeTree(fixture.root + "/restored", ["new/b.txt": "new"])
        _ = try await fixture.runtime.replaceAttachments(from: fixture.root + "/restored")
        try await fixture.runtime.writeState(
            set: ["pendingDatabaseSwitch": .object(["previousDatabase": .string("vision_native_previous_x")])],
            remove: [])

        let recovery = try await fixture.runtime.recoverPendingAttachmentSwitch()
        #expect(recovery == .rolledBack)
        #expect(BackupFiles.exists(live + "/old/a.txt"))
        #expect(fixture.pending() == nil)
        let state = try #require(fixture.harness.fileSystem.json(fixture.layout.state))
        #expect(state["pendingDatabaseSwitch"] != nil)
    }

    @Test func launchRecoveryKeepsTheRestoredTreeOnceTheDatabaseSwitchIsFinal() async throws {
        let fixture = try AttachmentRuntime()
        defer { fixture.remove() }
        let live = fixture.layout.attachments
        try fixture.makeTree(live, ["old/a.txt": "old"])
        try fixture.makeTree(fixture.root + "/restored", ["new/b.txt": "new"])
        let token = try await fixture.runtime.replaceAttachments(from: fixture.root + "/restored")

        let recovery = try await fixture.runtime.recoverPendingAttachmentSwitch()
        #expect(recovery == .finalized)
        #expect(BackupFiles.exists(live + "/new/b.txt"))
        let previous = try #require(token.previousDirectory)
        #expect(!BackupFiles.exists(previous))
        #expect(fixture.pending() == nil)
        let nothing = try await fixture.runtime.recoverPendingAttachmentSwitch()
        #expect(nothing == nil)
    }

    @Test func exportCopiesTheLiveTree() async throws {
        let fixture = try AttachmentRuntime()
        defer { fixture.remove() }
        try fixture.makeTree(fixture.layout.attachments, ["tx/r.txt": "r"])
        try await fixture.runtime.exportAttachments(to: fixture.root + "/export")
        let copied = try readBytes(fixture.root + "/export/tx/r.txt")
        #expect(copied == Array("r".utf8))
    }
}

/// Coordinated startup recovery (ADR-207, native.test.ts "startup recovers interrupted
/// restore … before bootstrap"): the first bootstrap resolves the persisted switch at
/// every rename boundary, never creates a replacement live database, and a second
/// bootstrap leaves the result alone.
@Suite struct NativeRestoreRecoveryTests {
    private static let live = "vision_native"
    private static let previous = "vision_native_previous_fixture"
    private static let activated = "vision_native_restore_fixture"

    private func writeMarker(_ harness: Harness, _ state: JSONValue) throws {
        harness.fileSystem.addFile(harness.layout.state, try state.serialized())
    }

    private func createdLive(_ harness: Harness) -> Bool {
        harness.runner.calls(named: "createdb").contains { $0.arguments.last == Self.live }
    }

    @Test(arguments: ["before", "between", "after"])
    func startupRecoversAnInterruptedRestoreBeforeBootstrap(_ phase: String) async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        try await runtime.ensurePostgresReady()
        switch phase {
        case "before": harness.databases = [Self.live, Self.activated]
        case "between": harness.databases = [Self.previous, Self.activated]
        default: harness.databases = [Self.previous, Self.live]
        }
        try writeMarker(
            harness,
            .object([
                "activeRuntime": .string("native"),
                "pendingDatabaseSwitch": .object([
                    "version": .int(1), "liveDatabase": .string(Self.live), "previousDatabase": .string(Self.previous),
                    "activatedDatabase": .string(Self.activated),
                ]),
            ]))

        try await runtime.bootstrapDatabase()
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"] == nil)
        #expect(harness.databases.contains(Self.live))
        #expect(!harness.databases.contains(Self.previous))
        #expect(!createdLive(harness))
        if phase == "after" {
            // The candidate was kept aside under a failed name; the original is live again.
            let failed = try #require(state["lastRollback"]?["preservedFailedDatabase"]?.stringValue)
            #expect(harness.databases == [Self.live, failed])
        } else {
            #expect(harness.databases == [Self.live, Self.activated])
        }

        let settled = harness.databases
        try await runtime.bootstrapDatabase()
        #expect(harness.databases == settled)
        #expect(!createdLive(harness))
    }

    @Test func anAmbiguousSwitchFailsClosedWithoutAReplacementDatabase() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        try await runtime.ensurePostgresReady()
        harness.databases = [Self.activated]
        try writeMarker(
            harness,
            .object([
                "pendingDatabaseSwitch": .object([
                    "version": .int(1), "liveDatabase": .string(Self.live), "previousDatabase": .string(Self.previous),
                    "activatedDatabase": .string(Self.activated),
                ])
            ]))
        for _ in 0..<2 {
            let error = await #expect(throws: NativeRuntimeError.self) { try await runtime.bootstrapDatabase() }
            #expect(error?.code == "DATABASE_SWITCH_UNSAFE")
        }
        #expect(!createdLive(harness))
        #expect(harness.fileSystem.json(harness.layout.state)?["pendingDatabaseSwitch"] != nil)
    }

    @Test func aMalformedAttachmentJournalFailsClosed() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        for destination in ["/elsewhere/attachments", harness.layout.attachments] {
            let previous: JSONValue =
                destination == harness.layout.attachments ? .string("/elsewhere/attachments.previous-1") : .null
            try writeMarker(
                harness,
                .object([
                    "pendingAttachmentSwitch": .object([
                        "count": .int(0), "digest": .string(""), "entries": .array([]),
                        "previousDirectory": previous, "destinationDirectory": .string(destination),
                    ])
                ]))
            let error = await #expect(throws: NativeRuntimeError.self) { try await runtime.recoverInterruptedRestore() }
            #expect(error?.code == "INVALID_RESTORE_JOURNAL")
            #expect(harness.fileSystem.json(harness.layout.state)?["pendingAttachmentSwitch"] != nil)
        }
        let error = await #expect(throws: NativeRuntimeError.self) { try await runtime.bootstrapDatabase() }
        #expect(error?.code == "INVALID_RESTORE_JOURNAL")
        #expect(!createdLive(harness))
    }

    @Test func aMarkerThatIsNotAnObjectIsRejected() async throws {
        let harness = try Harness()
        harness.fileSystem.addFile(harness.layout.state, "[]")
        let error = await #expect(throws: NativeRuntimeError.self) { try await harness.makeRuntime().readState() }
        #expect(error?.code == "INVALID_RUNTIME_STATE")
    }

    @Test func aFinalizedDatabaseSwitchOnlyCleansUpTheAttachmentJournal() async throws {
        let fixture = try AttachmentRuntime()
        defer { fixture.remove() }
        let live = fixture.layout.attachments
        try fixture.makeTree(live, ["old/a.txt": "old"])
        try fixture.makeTree(fixture.root + "/restored", ["new/b.txt": "new"])
        let token = try await fixture.runtime.replaceAttachments(from: fixture.root + "/restored")
        #expect(try fixture.pending()?.decode(DirectorySwitchToken.self) == token)

        let previous = try #require(token.previousDirectory)
        try await fixture.runtime.recoverInterruptedRestore()
        #expect(BackupFiles.exists(live + "/new/b.txt"))
        #expect(!BackupFiles.exists(previous))
        #expect(fixture.pending() == nil)
    }
}
