import Darwin
import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct NativeRuntimeLifecycleTests {
    @Test func firstStartCreatesThePrivateLayoutAndSpawnsTheBackend() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        let result = try await runtime.start()

        #expect(try harness.fileSystem.mode(harness.layout.databaseDirectory) == 0o700)
        #expect(try harness.fileSystem.mode(harness.layout.env) == 0o600)
        #expect(harness.fileSystem.text(harness.layout.env) == RuntimeEnvFile.header)

        let spawns = harness.spawner.spawns
        #expect(spawns.count == 1)
        let backend = try #require(spawns.first)
        #expect(backend.executable == "\(testRuntimeRoot)/vision-backend")
        #expect(backend.cwd == testRuntimeRoot)
        #expect(backend.environment["PORT"] == "41000")
        #expect(backend.environment["SERVER_HOST"] == "127.0.0.1")
        #expect(backend.environment["HOME"] == testHome)
        #expect(backend.environment["VISION_DATABASE_PATH"] == harness.layout.database)
        #expect(backend.environment["APP_TIMEZONE"] != nil)
        #expect(backend.environment["DATABASE_URL"] == nil)
        #expect(backend.logPath == harness.layout.backendLog)
        #expect(result == .started(pid: backend.pid, port: 41_000, database: harness.layout.database))
        let backendRecord = try #require(harness.fileSystem.json(harness.layout.pid))
        #expect(backendRecord["command"] == .string("vision-backend"))
        #expect(backendRecord["port"] == .int(41_000))

        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["activeRuntime"] == .string("native"))
        #expect(state["runtimeId"] == .string("vision_native"))
        // The backend creates and migrates the database itself; the shell runs no tool first.
        #expect(harness.toolCommands.isEmpty)
        #expect(harness.fileSystem.paths(withPrefix: "/tmp/").isEmpty)
    }

    @Test func runtimeEnvLosesTheRetiredDatabaseServerSettings() async throws {
        let harness = try Harness()
        harness.fileSystem.addFile(
            harness.layout.env,
            RuntimeEnvFile.header + "DATABASE_URL=postgresql://x@127.0.0.1/vision\nTWELVE_DATA_API_KEY=abc\n",
            mode: 0o644)
        try await harness.makeRuntime().ensureLayout()
        let env = try #require(harness.fileSystem.text(harness.layout.env))
        #expect(!env.contains("DATABASE_URL"))
        #expect(env.contains("TWELVE_DATA_API_KEY=abc"))
        #expect(try harness.fileSystem.mode(harness.layout.env) == 0o600)
    }

    @Test func occupiedBackendPortIsReportedForRepicking() async throws {
        let harness = try Harness()
        harness.ports.occupy(41_000)
        let error = await #expect(throws: NativeRuntimeError.self) { try await harness.makeRuntime().start() }
        #expect(error?.code == "PORT_COLLISION")
        #expect(harness.spawner.spawns.isEmpty)
    }

    @Test func healthyRecordedBackendIsReused() async throws {
        let harness = try Harness()
        let first = try await harness.makeRuntime().start()
        guard case .started(let pid, _, _) = first else {
            Issue.record("expected a started backend")
            return
        }
        let second = try await harness.makeRuntime().start()
        #expect(second == .alreadyRunning(pid: pid, port: 41_000))
        #expect(harness.spawner.spawns.filter { $0.executable.hasSuffix("vision-backend") }.count == 1)
    }

    @Test func unhealthyRecordedBackendIsStoppedAndReplaced() async throws {
        let harness = try Harness()
        harness.processes.add(778)
        harness.fileSystem.addFile(harness.layout.pid, #"{"pid":778,"port":41000}"#)
        harness.http.handler = { _ in HTTPResponse(status: 503) }
        let result = try await harness.makeRuntime().start()
        guard case .started(let pid, let port, _) = result else {
            Issue.record("expected a fresh backend, got \(result)")
            return
        }
        #expect(pid != 778)
        #expect(port == 41_000)
        #expect(harness.processes.sentSignals.map { $0.0 } == [778])
        #expect(harness.processes.sentSignals.map { $0.1 } == [SIGTERM])
        #expect(!harness.processes.exists(778))
        #expect(harness.fileSystem.json(harness.layout.pid)?["pid"] == .int(Int(pid)))
    }

    @Test func runtimeEnvThatIsNotARegularFileIsRefused() async throws {
        for node in [FakeFileSystem.Node.symlink("/Users/demo/elsewhere.env"), .fifo] {
            let harness = try Harness()
            harness.fileSystem.addFile("/Users/demo/elsewhere.env", "TWELVE_DATA_API_KEY=x\n", mode: 0o644)
            harness.fileSystem.addNode(harness.layout.env, node)
            let runtime = try harness.makeRuntime()
            let error = await #expect(throws: NativeRuntimeError.self) { try await runtime.ensureLayout() }
            #expect(error?.code == "INVALID_RUNTIME_ENV")
            #expect(harness.fileSystem.node(harness.layout.env) == node)
            #expect(try harness.fileSystem.mode("/Users/demo/elsewhere.env") == 0o644)
        }
    }

    @Test func recordedPIDOwnedByAnotherProgramIsNeverSignalled() async throws {
        let harness = try Harness()
        harness.processes.add(777)
        harness.fileSystem.addFile(harness.layout.pid, #"{"pid":777,"port":41000}"#)
        harness.psOutput = "/Applications/Safari.app/Contents/MacOS/Safari\n"
        let runtime = try harness.makeRuntime()
        let startError = await #expect(throws: NativeRuntimeError.self) { try await runtime.start() }
        #expect(startError?.code == "BACKEND_PID_OWNERSHIP_MISMATCH")
        let stopError = await #expect(throws: NativeRuntimeError.self) { try await runtime.stopBackend() }
        #expect(stopError?.code == "BACKEND_PID_OWNERSHIP_MISMATCH")
        #expect(harness.processes.sentSignals.isEmpty)
        #expect(harness.fileSystem.exists(harness.layout.pid))
    }

    @Test func stalePIDRecordIsRemoved() async throws {
        let harness = try Harness()
        harness.fileSystem.addFile(harness.layout.pid, #"{"pid":4242}"#)
        try await harness.makeRuntime().stopBackend()
        #expect(!harness.fileSystem.exists(harness.layout.pid))
        #expect(harness.processes.sentSignals.isEmpty)
    }

    @Test func untrustworthyPIDsAreIgnored() async throws {
        let harness = try Harness()
        harness.processes.add(1)
        harness.fileSystem.addFile(harness.layout.pid, #"{"pid":1}"#)
        try await harness.makeRuntime().stopBackend()
        #expect(harness.processes.sentSignals.isEmpty)
    }

    @Test func stopSendsTermThenKillAfterTenSeconds() async throws {
        let harness = try Harness()
        harness.processes.add(900, ignoresTerm: true)
        harness.fileSystem.addFile(harness.layout.pid, #"{"pid":900}"#)
        let started = harness.clock.now()
        try await harness.makeRuntime().stopBackend()
        let signals = harness.processes.sentSignals
        #expect(signals.map { $0.1 } == [SIGTERM, SIGKILL])
        #expect(signals.allSatisfy { $0.0 == 900 })
        #expect(harness.clock.now().timeIntervalSince(started) >= 10)
        #expect(!harness.fileSystem.exists(harness.layout.pid))
    }

    /// native.ts `stopBackend`: a backend that survives SIGKILL makes a snapshot unsafe.
    @Test func aBackendThatSurvivesKillFailsTheStop() async throws {
        let harness = try Harness()
        harness.processes.add(901, survivesKill: true)
        harness.fileSystem.addFile(harness.layout.pid, #"{"pid":901}"#)
        let started = harness.clock.now()
        let error = await #expect(throws: NativeRuntimeError.self) { try await harness.makeRuntime().stopBackend() }
        #expect(error?.code == "BACKEND_STOP_FAILED")
        #expect(harness.processes.sentSignals.map { $0.1 } == [SIGTERM, SIGKILL])
        #expect(harness.clock.now().timeIntervalSince(started) >= 20)
        #expect(harness.fileSystem.exists(harness.layout.pid))
    }

    @Test func cooperativeBackendOnlyGetsTerm() async throws {
        let harness = try Harness()
        _ = try await harness.makeRuntime().start()
        try await harness.makeRuntime().stopBackend()
        #expect(harness.processes.sentSignals.map { $0.1 } == [SIGTERM])
    }

    @Test func stopWithoutABackendIsANoOp() async throws {
        let harness = try Harness()
        try await harness.makeRuntime().stop()
        #expect(harness.runner.calls.isEmpty)
        #expect(harness.processes.sentSignals.isEmpty)
    }

    @Test func detailedReadinessWaitsForTheDatabase() async throws {
        let harness = try Harness()
        let probes = LockedValue(0)
        harness.http.handler = { _ in
            let count = probes.withLock { (value: inout Int) -> Int in
                value += 1
                return value
            }
            let connected = count >= 3
            return HTTPResponse(status: 200, body: Data(#"{"database":{"connected":\#(connected)}}"#.utf8))
        }
        let runtime = try harness.makeRuntime()
        _ = try await runtime.waitUntilReady(attempts: 5, intervalMilliseconds: 10, detailed: true)
        #expect(probes.withLock { $0 } == 3)
    }

    @Test func readinessTimesOut() async throws {
        let harness = try Harness()
        harness.http.handler = { _ in HTTPResponse(status: 503) }
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await harness.makeRuntime().waitUntilReady(attempts: 3, intervalMilliseconds: 10)
        }
        #expect(error?.code == "BACKEND_NOT_READY")
    }

    @Test func aBackendThatExitsDuringStartupReportsItsOwnError() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        let idle = await runtime.backendStartupFailure()
        #expect(idle == nil)
        _ = try await runtime.start()
        let running = await runtime.backendStartupFailure()
        #expect(running == nil)

        let backend = try #require(harness.spawner.spawns.last)
        harness.fileSystem.addFile(
            harness.layout.backendLog,
            "2026-10-19T18:45:42.512Z [ERROR] Failed to start application {\"error\":\"migration 0004 failed\"}\n")
        harness.spawner.markExited(backend.pid)
        let failure = await runtime.backendStartupFailure()
        #expect(failure == BackendStartupFailure(message: "migration 0004 failed"))

        harness.fileSystem.addFile(
            harness.layout.backendLog,
            "[ERROR] Failed to start application {\"error\":\"disk full\",\"code\":\"PRE_MIGRATION_BACKUP_FAILED\"}\n")
        let backup = await runtime.backendStartupFailure()
        #expect(backup == BackendStartupFailure(message: "disk full", code: "PRE_MIGRATION_BACKUP_FAILED"))

        harness.fileSystem.addFile(harness.layout.backendLog, "no structured error\n")
        let generic = await runtime.backendStartupFailure()
        #expect(generic == BackendStartupFailure(message: "The Vision backend stopped during startup."))
    }

    @Test func backendLogTailDropsColourCodes() async throws {
        let harness = try Harness()
        harness.fileSystem.addFile(harness.layout.backendLog, "boot\n\u{1B}[31mred error\u{1B}[0m\n")
        let tail = try await harness.makeRuntime().backendLogTail()
        #expect(tail.contains("red error"))
        #expect(!tail.contains("\u{1B}"))
    }
}

@Suite struct NativeRuntimeDatabaseToolTests {
    @Test func verifyRunsThePackagedToolThroughTheBackendExecutable() async throws {
        let harness = try Harness()
        let data = harness.installDatabase()
        let report = try await harness.makeRuntime().verifyDatabaseFile(harness.layout.database)
        #expect(report.sha256 == sha256Hex(data))
        #expect(report.bytes == data.count)
        #expect(report.schemaVersion == Harness.packagedSchemaVersion)
        #expect(report.pendingMigrations == 0)
        #expect(report.tableCounts == harness.tableCounts)

        let call = try #require(harness.runner.calls(named: "vision-backend").last)
        #expect(call.arguments == ["\(testRuntimeRoot)/tools/db-file.js", "verify", harness.layout.database])
        #expect(call.options.cwd == testRuntimeRoot)
        #expect(call.options.environment["BUN_BE_BUN"] == "1")
        #expect(call.options.environment["VISION_SKIP_DOTENV"] == "1")
        #expect(call.options.environment["VISION_DATABASE_PATH"] == harness.layout.database)
    }

    @Test func aToolFailureCarriesTheToolsOwnError() async throws {
        let harness = try Harness()
        harness.installDatabase()
        harness.failTool("verify", "database disk image is malformed")
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await harness.makeRuntime().verifyDatabaseFile(harness.layout.database)
        }
        #expect(error == NativeRuntimeError("DATABASE_VERIFY_FAILED", "database disk image is malformed"))
    }

    @Test func aMissingToolIsReportedAsAnInstallationProblem() async throws {
        let harness = try Harness()
        try harness.fileSystem.remove("\(testRuntimeRoot)/tools/db-file.js")
        harness.writeManifest()
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await harness.makeRuntime().verifyDatabaseFile(harness.layout.database)
        }
        #expect(error?.code == "DATABASE_TOOL_MISSING")
    }

    @Test func snapshotLandsAtItsFinalNameOnlyOnceVerified() async throws {
        let harness = try Harness()
        let data = harness.installDatabase()
        let runtime = try harness.makeRuntime()
        let destination = "/Users/demo/Backups/work/db.sqlite3"
        let report = try await runtime.snapshotDatabase(to: destination)
        #expect(report.file == destination)
        #expect(report.sha256 == sha256Hex(data))
        #expect(harness.toolCommands.last == ["snapshot", harness.layout.database, "\(destination).partial"])
        #expect(!harness.fileSystem.exists("\(destination).partial"))
        #expect(try harness.fileSystem.mode(destination) == 0o600)

        harness.failTool("snapshot", "disk full")
        let failed = "/Users/demo/Backups/work/second.sqlite3"
        let error = await #expect(throws: NativeRuntimeError.self) { try await runtime.snapshotDatabase(to: failed) }
        #expect(error?.code == "DATABASE_SNAPSHOT_FAILED")
        #expect(!harness.fileSystem.exists(failed))
        #expect(!harness.fileSystem.exists("\(failed).partial"))
    }

    @Test func snapshotWithoutADatabaseFailsClearly() async throws {
        let harness = try Harness()
        let error = await #expect(throws: NativeRuntimeError.self) {
            try await harness.makeRuntime().snapshotDatabase(to: "/Users/demo/Backups/db.sqlite3")
        }
        #expect(error?.code == "DATABASE_MISSING")
        #expect(harness.toolCommands.isEmpty)
    }

    @Test func pendingSchemaUpgradeComparesTheHeaderWithThePackagedMigrations() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        #expect(await runtime.packagedMigrationVersion() == Harness.packagedSchemaVersion)
        #expect(await runtime.pendingSchemaUpgrade() == nil)

        harness.installDatabase(userVersion: 1)
        #expect(await runtime.pendingSchemaUpgrade() == PendingSchemaUpgrade(databaseVersion: 1, packagedVersion: 3))
        harness.installDatabase(userVersion: 0)
        #expect(await runtime.pendingSchemaUpgrade() == nil)
        harness.installDatabase(userVersion: 3)
        #expect(await runtime.pendingSchemaUpgrade() == nil)
        // No tool runs: the header is read directly.
        #expect(harness.toolCommands.isEmpty)
    }

    @Test func databaseStatsReadTheHeaderAndSidecars() async throws {
        let harness = try Harness()
        let data = harness.installDatabase(userVersion: 2)
        harness.fileSystem.addFile("\(harness.layout.database)-wal", Data(count: 512))
        let stats = try await harness.makeRuntime().getDatabaseStats()
        #expect(stats.exists)
        #expect(stats.bytes == data.count)
        #expect(stats.walBytes == 512)
        #expect(stats.schemaVersion == 2)
        #expect(stats.journalMode == .wal)
        #expect(stats.sqliteVersion == "3.43.2")
    }
}
