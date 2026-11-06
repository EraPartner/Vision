import Foundation
import Testing
@testable import VisionNativeCore

// The runtime side of backup and restore: the database generation switch (stage, verify,
// two journaled directory renames), its finalization and rollback.

private let restoreSource = "/Users/demo/Restore/db.sqlite3"

/// The fake's switch generation nonce: the clock's milliseconds and four random bytes.
private func generations(_ harness: Harness, _ kind: String) -> [String] {
    (try? harness.fileSystem.contentsOfDirectory(testUserData))?
        .filter { $0.hasPrefix("database.\(kind)-") }.map { "\(testUserData)/\($0)" } ?? []
}

@Suite struct NativeRuntimeDatabaseSwitchTests {
    @Test func activationStagesVerifiesAndSwapsTheGenerations() async throws {
        let harness = try Harness()
        let old = harness.installDatabase(body: "old")
        let restored = sqliteDatabase(userVersion: 3, body: "restored")
        harness.fileSystem.addFile(restoreSource, restored)
        let runtime = try harness.makeRuntime()

        let activation = try await runtime.activateRestoredDatabase(
            restoreSource, expectedSchemaVersion: 3, expectedSha256: sha256Hex(restored))
        let token = activation.switchToken
        #expect(token.version == 2)
        #expect(token.kind == "sqlite-directory")
        #expect(token.liveDirectory == harness.layout.databaseDirectory)
        #expect(activation.validation.sha256 == sha256Hex(restored))
        #expect(harness.toolCommands.first?.first == "verify")
        #expect(harness.toolCommands.first?.last == "\(token.activatedDirectory)/vision.sqlite3")

        #expect(try harness.fileSystem.readFile(harness.layout.database) == restored)
        #expect(try harness.fileSystem.mode(harness.layout.database) == 0o600)
        #expect(try harness.fileSystem.readFile("\(token.previousDirectory)/vision.sqlite3") == old)
        #expect(!harness.fileSystem.exists(token.activatedDirectory))
        #expect(try harness.fileSystem.readFile(restoreSource) == restored)
        #expect(harness.fileSystem.syncedDirectories.contains(testUserData))
        let pending = harness.fileSystem.json(harness.layout.state)?["pendingDatabaseSwitch"]
        #expect(try pending?.decode(DatabaseSwitchToken.self) == token)
    }

    @Test(arguments: [
        (String(repeating: "0", count: 64), 3, "DATABASE_CHECKSUM_MISMATCH"),
        (nil, 2, "DATABASE_SCHEMA_MISMATCH"),
    ] as [(String?, Int, String)])
    func aCopyThatFailsVerificationLeavesTheLiveDatabaseAlone(
        _ sha256: String?, _ schemaVersion: Int, _ code: String
    ) async throws {
        let harness = try Harness()
        let old = harness.installDatabase(body: "old")
        harness.fileSystem.addFile(restoreSource, sqliteDatabase(userVersion: 3, body: "restored"))
        let runtime = try harness.makeRuntime()
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await runtime.activateRestoredDatabase(
                restoreSource, expectedSchemaVersion: schemaVersion, expectedSha256: sha256)
        }
        #expect(error?.code == code)
        #expect(try harness.fileSystem.readFile(harness.layout.database) == old)
        #expect(generations(harness, "restore").isEmpty)
        #expect(generations(harness, "previous").isEmpty)
        #expect(harness.fileSystem.json(harness.layout.state)?["pendingDatabaseSwitch"] == nil)
    }

    @Test func aFileThatIsNotADatabaseIsRefusedByTheTool() async throws {
        let harness = try Harness()
        harness.installDatabase()
        harness.fileSystem.addFile(restoreSource, "CREATE TABLE t (id integer);\n")
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await harness.makeRuntime().activateRestoredDatabase(
                restoreSource, expectedSchemaVersion: nil, expectedSha256: nil)
        }
        #expect(error?.code == "DATABASE_VERIFY_FAILED")
        #expect(generations(harness, "restore").isEmpty)
    }

    @Test func anEmptySourceIsRefusedBeforeAnyCopy() async throws {
        let harness = try Harness()
        harness.fileSystem.addFile(restoreSource, Data())
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await harness.makeRuntime().activateRestoredDatabase(
                restoreSource, expectedSchemaVersion: nil, expectedSha256: nil)
        }
        #expect(error?.code == "INVALID_DATABASE_FILE")
        #expect(harness.toolCommands.isEmpty)
    }

    @Test func rollbackPutsThePreviousGenerationBackAndKeepsTheFailedOne() async throws {
        let harness = try Harness()
        let old = harness.installDatabase(body: "old")
        let restored = sqliteDatabase(userVersion: 3, body: "restored")
        harness.fileSystem.addFile(restoreSource, restored)
        let runtime = try harness.makeRuntime()
        let activation = try await runtime.activateRestoredDatabase(
            restoreSource, expectedSchemaVersion: nil, expectedSha256: nil)

        try await runtime.rollbackDatabaseSwitch(nil)
        #expect(try harness.fileSystem.readFile(harness.layout.database) == old)
        #expect(!harness.fileSystem.exists(activation.switchToken.previousDirectory))
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"] == nil)
        let failed = try #require(state["lastRollback"]?["preservedFailedDatabase"]?.stringValue)
        #expect(PathUtilities.basename(failed).hasPrefix("database.failed-"))
        #expect(try harness.fileSystem.readFile("\(failed)/vision.sqlite3") == restored)
    }

    @Test func aTokenNamingAForeignDirectoryIsRefused() async throws {
        let harness = try Harness()
        harness.installDatabase()
        let token = DatabaseSwitchToken(
            liveDirectory: harness.layout.databaseDirectory, previousDirectory: "/Users/demo/Documents",
            activatedDirectory: "\(testUserData)/database.restore-1-aa", activatedAt: "2026-11-06T00:00:00.000Z")
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await harness.makeRuntime().rollbackDatabaseSwitch(try JSONValue(encoding: token))
        }
        #expect(error?.code == "NO_DATABASE_SWITCH")
        #expect(harness.fileSystem.exists(harness.layout.database))
    }

    @Test func finalizeClearsTheSwitchAndKeepsThreePreviousGenerations() async throws {
        let harness = try Harness()
        harness.installDatabase(body: "old")
        for index in 0..<4 {
            let path = "\(testUserData)/database.previous-\(index)-00000000"
            harness.fileSystem.addFile("\(path)/vision.sqlite3", sqliteDatabase(userVersion: 3, body: "\(index)"))
            harness.fileSystem.setModificationDate(path, Date(timeIntervalSince1970: Double(1_000 + index)))
        }
        harness.fileSystem.addFile(restoreSource, sqliteDatabase(userVersion: 3, body: "restored"))
        let runtime = try harness.makeRuntime()
        let activation = try await runtime.activateRestoredDatabase(
            restoreSource, expectedSchemaVersion: nil, expectedSha256: nil)
        harness.fileSystem.setModificationDate(
            activation.switchToken.previousDirectory, Date(timeIntervalSince1970: 2_000))

        try await runtime.finalizeDatabaseSwitch(activation.switchToken)
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"] == nil)
        #expect(state["previousDatabase"] == .string(activation.switchToken.previousDirectory))
        #expect(
            Set(generations(harness, "previous")) == [
                activation.switchToken.previousDirectory,
                "\(testUserData)/database.previous-3-00000000",
                "\(testUserData)/database.previous-2-00000000",
            ])
    }

    @Test func aQuitBeforeThePlanIsPersistedDropsTheStagingGeneration() async throws {
        let harness = try Harness()
        harness.installDatabase()
        harness.fileSystem.addFile(restoreSource, sqliteDatabase(userVersion: 3, body: "restored"))
        let runtime = try harness.makeRuntime()
        let staged = Latch()
        let release = Latch()
        harness.runner.gate = { call in
            guard call.name == "vision-backend" else { return }
            staged.open()
            await release.wait()
        }
        let activation = Task {
            try await runtime.activateRestoredDatabase(restoreSource, expectedSchemaVersion: nil, expectedSha256: nil)
        }
        await staged.wait()
        #expect(generations(harness, "restore").count == 1)
        await runtime.beginShutdown()
        await runtime.discardStagingRestore()
        #expect(generations(harness, "restore").isEmpty)
        release.open()
        let error = await #expect(throws: (any Error).self) { try await activation.value }
        #expect(error != nil)
        #expect(harness.fileSystem.json(harness.layout.state)?["pendingDatabaseSwitch"] == nil)
    }
}

@Suite struct NativeRuntimePayloadTimingTests {
    @Test func theLaunchTimesThePayloadVerification() async throws {
        let harness = try Harness()
        let phases = LockedValue<[String]>([])
        let runtime = try NativeRuntime(
            layout: harness.layout, runtimeRoot: testRuntimeRoot, appPort: 41_000,
            inheritedEnvironment: ["PATH": "/usr/bin", "HOME": testHome], dependencies: harness.dependencies,
            recordBootPhase: { phase, _ in phases.withLock { $0.append(phase) } })
        _ = try await runtime.start()
        #expect(phases.withLock { $0 } == ["runtime_manifest_full"])
        try await runtime.stop()

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
    @Test func thePackagedMigrationVersionComesFromThePayload() async throws {
        let harness = try Harness(payload: false)
        let runtime = try harness.makeRuntime()
        #expect(await runtime.packagedMigrationVersion() == 0)
        for name in [
            "0129_prev.sql", "0130_head.sql", "0131_undo.down.sql", "0132_notes.txt", "_0999_hidden.sql", "readme.sql",
            "0133_Upper.sql",
        ] {
            harness.fileSystem.addFile("\(testRuntimeRoot)/db/migrations/\(name)", "-- migration\n")
        }
        #expect(await runtime.packagedMigrationVersion() == 130)
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
    private static let previous = "\(testUserData)/database.previous-1-fixture"
    private static let activated = "\(testUserData)/database.restore-1-fixture"
    private static let old = sqliteDatabase(userVersion: 3, body: "old")
    private static let restored = sqliteDatabase(userVersion: 3, body: "restored")

    private func writeMarker(_ harness: Harness, _ state: JSONValue) throws {
        harness.fileSystem.addFile(harness.layout.state, try state.serialized())
    }

    private func pendingSwitch(_ harness: Harness) throws -> JSONValue {
        try JSONValue(
            encoding: DatabaseSwitchToken(
                liveDirectory: harness.layout.databaseDirectory, previousDirectory: Self.previous,
                activatedDirectory: Self.activated, activatedAt: "2026-11-06T00:00:00.000Z"))
    }

    @Test(arguments: ["before", "between", "after"])
    func startupRecoversAnInterruptedRestoreBeforeTheBackendOpensTheDatabase(_ phase: String) async throws {
        let harness = try Harness()
        let live = harness.layout.database
        switch phase {
        case "before":
            harness.fileSystem.addFile(live, Self.old)
            harness.fileSystem.addFile("\(Self.activated)/vision.sqlite3", Self.restored)
        case "between":
            harness.fileSystem.addFile("\(Self.previous)/vision.sqlite3", Self.old)
            harness.fileSystem.addFile("\(Self.activated)/vision.sqlite3", Self.restored)
        default:
            harness.fileSystem.addFile("\(Self.previous)/vision.sqlite3", Self.old)
            harness.fileSystem.addFile(live, Self.restored)
        }
        try writeMarker(
            harness,
            .object(["activeRuntime": .string("native"), "pendingDatabaseSwitch": try pendingSwitch(harness)]))

        let runtime = try harness.makeRuntime()
        try await runtime.ensureDatabaseReady()
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"] == nil)
        #expect(try harness.fileSystem.readFile(live) == Self.old)
        #expect(!harness.fileSystem.exists(Self.previous))
        let preserved = try #require(state["lastRollback"]?["preservedFailedDatabase"]?.stringValue)
        if phase == "after" {
            #expect(PathUtilities.basename(preserved).hasPrefix("database.failed-"))
            #expect(try harness.fileSystem.readFile("\(preserved)/vision.sqlite3") == Self.restored)
        } else {
            #expect(preserved == Self.activated)
            #expect(try harness.fileSystem.readFile("\(Self.activated)/vision.sqlite3") == Self.restored)
        }

        let settled = harness.fileSystem.paths(withPrefix: testUserData + "/database")
        try await runtime.ensureDatabaseReady()
        #expect(harness.fileSystem.paths(withPrefix: testUserData + "/database") == settled)
    }

    @Test func anAmbiguousSwitchFailsClosedEveryTime() async throws {
        let harness = try Harness()
        harness.fileSystem.addFile("\(Self.activated)/vision.sqlite3", Self.restored)
        try writeMarker(harness, .object(["pendingDatabaseSwitch": try pendingSwitch(harness)]))
        let runtime = try harness.makeRuntime()
        for _ in 0..<2 {
            let error = await #expect(throws: NativeRuntimeError.self) { try await runtime.start() }
            #expect(error?.code == "DATABASE_SWITCH_UNSAFE")
        }
        #expect(harness.spawner.spawns.isEmpty)
        #expect(!harness.fileSystem.exists(harness.layout.database))
        #expect(harness.fileSystem.json(harness.layout.state)?["pendingDatabaseSwitch"] != nil)
    }

    @Test func aJournalFromTheDatabaseServerVersionIsLeftAlone() async throws {
        let harness = try Harness()
        let legacy = JSONValue.object([
            "version": .int(1), "liveDatabase": .string("vision_native"),
            "previousDatabase": .string("vision_native_previous_x"), "activatedDatabase": .string("vision_native_restore_x"),
        ])
        try writeMarker(harness, .object(["activeRuntime": .string("native"), "pendingDatabaseSwitch": legacy]))
        _ = try await harness.makeRuntime().start()
        #expect(harness.fileSystem.json(harness.layout.state)?["pendingDatabaseSwitch"] == legacy)
        #expect(harness.spawner.spawns.count == 1)
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
        let error = await #expect(throws: NativeRuntimeError.self) { try await runtime.ensureDatabaseReady() }
        #expect(error?.code == "INVALID_RESTORE_JOURNAL")
        #expect(harness.spawner.spawns.isEmpty)
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
