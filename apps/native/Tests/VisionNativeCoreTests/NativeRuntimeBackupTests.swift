import Foundation
import Testing
@testable import VisionNativeCore

// The runtime side of backup and restore: pg_dump, the schema head and a plain-SQL
// restore into a staging database.

private let schemaHeadQuery = "SELECT version_num FROM alembic_version ORDER BY version_num;"

private func backupHarness(dumpContent: String = "-- dump\n") throws -> Harness {
    let harness = try Harness()
    let base = harness.runner.handler
    let fileSystem = harness.fileSystem
    harness.runner.handler = { call in
        if call.name == "psql", call.arguments.contains(schemaHeadQuery) {
            return RunResult(stdout: "0129_prev\n0130_head\n")
        }
        if call.name == "pg_dump", let index = call.arguments.firstIndex(of: "--file") {
            fileSystem.addFile(call.arguments[index + 1], dumpContent)
            return RunResult()
        }
        return try base(call)
    }
    return harness
}

@Suite struct NativeRuntimeBackupTests {
    @Test func theSchemaHeadIsTheHighestRevision() async throws {
        let harness = try backupHarness()
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        let head = try await runtime.schemaHead()
        #expect(head == "0130_head")
        let call = try #require(harness.runner.calls(named: "psql").first { $0.arguments.contains(schemaHeadQuery) })
        #expect(call.arguments.contains("vision_native_owner"))
        #expect(call.options.environment["PGPASSFILE"] != nil)
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
        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["pendingDatabaseSwitch"]?["previousDatabase"] == .string(token.previousDatabase))
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
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        let empty = await runtime.migrationChainHead()
        #expect(empty == "")
        for name in ["0129_prev.py", "0130_head.py", "__init__.py", "0131_notes.txt", "_0999_hidden.py", "readme.py"] {
            harness.fileSystem.addFile("\(testRuntimeRoot)/alembic/versions/\(name)", "# migration\n")
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
