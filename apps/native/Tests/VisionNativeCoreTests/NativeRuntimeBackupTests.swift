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
