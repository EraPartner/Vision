import Darwin
import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct NativeRuntimeLifecycleTests {
    @Test func firstStartCreatesAPrivateClusterRolesAndBackend() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        let result = try await runtime.start()

        let initdb = try #require(harness.runner.calls(named: "initdb").first)
        #expect(initdb.arguments.contains("--locale=C"))
        #expect(initdb.arguments.contains("--data-checksums"))
        #expect(initdb.arguments.contains("--auth-host=scram-sha-256"))
        #expect(initdb.options.environment["LC_ALL"] == "C")
        let username = initdb.arguments.firstIndex(of: "--username").map { initdb.arguments[$0 + 1] }
        #expect(username == "vision_native_admin")

        let data = harness.layout.postgresData
        #expect(harness.fileSystem.text("\(data)/PG_VERSION") == "18\n")
        #expect(harness.fileSystem.text("\(data)/vision.conf") == PostgresSQL.visionConf(port: 54331))
        #expect(PostgresSQL.includesVisionConf(harness.fileSystem.text("\(data)/postgresql.conf") ?? ""))
        #expect(try harness.fileSystem.mode(data) == 0o700)
        #expect(try harness.fileSystem.mode(harness.layout.env) == 0o600)

        let spawns = harness.spawner.spawns
        #expect(spawns.count == 2)
        let postgres = spawns[0]
        #expect(PathUtilities.basename(postgres.executable) == "postgres")
        #expect(postgres.arguments == PostgresSQL.serverArguments(dataDirectory: data, port: 54331))
        #expect(postgres.logPath == harness.layout.postgresLog)
        let postgresRecord = try #require(harness.fileSystem.json(harness.layout.postgresPid))
        #expect(postgresRecord["pid"] == .int(Int(postgres.pid)))
        #expect(postgresRecord["runtimeId"] == .string("vision_native"))

        #expect(harness.roles.isSuperset(of: ["vision_native_owner", "vision_native_app", RuntimeConstants.analysisRole]))
        #expect(harness.databases.contains("vision_native"))
        #expect(harness.adminSQL.allSatisfy { !$0.isEmpty })
        let extensionCall = harness.runner.calls(named: "psql").first {
            $0.arguments.contains(PostgresSQL.createExtensions)
        }
        #expect(extensionCall != nil)
        for call in harness.runner.calls(named: "psql") {
            #expect(call.options.environment["PGPASSFILE"] != nil)
            #expect(!call.arguments.joined(separator: " ").contains("PASSWORD"))
        }

        let backend = spawns[1]
        #expect(backend.executable == "\(testRuntimeRoot)/vision-backend")
        #expect(backend.cwd == testRuntimeRoot)
        #expect(backend.environment["PORT"] == "41000")
        #expect(backend.environment["SERVER_HOST"] == "127.0.0.1")
        #expect(backend.environment["HOME"] == testHome)
        #expect(backend.logPath == harness.layout.backendLog)
        #expect(result == .started(pid: backend.pid, port: 41_000, database: "vision_native"))
        let backendRecord = try #require(harness.fileSystem.json(harness.layout.pid))
        #expect(backendRecord["command"] == .string("vision-backend"))
        #expect(backendRecord["port"] == .int(41_000))

        let state = try #require(harness.fileSystem.json(harness.layout.state))
        #expect(state["activeRuntime"] == .string("native"))
        #expect(state["runtimeId"] == .string("vision_native"))
        #expect(await runtime.newClusterCreatedThisLaunch)
        #expect(harness.fileSystem.paths(withPrefix: "/tmp/").isEmpty)
    }

    @Test func secondStartReusesTheClusterAndRoles() async throws {
        let harness = try Harness()
        _ = try await harness.makeRuntime().start()
        try await harness.makeRuntime().stop(keepPostgres: false)
        let sqlCount = harness.adminSQL.count

        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        #expect(harness.runner.calls(named: "initdb").count == 1)
        #expect(!(await runtime.newClusterCreatedThisLaunch))
        let newSQL = harness.adminSQL.dropFirst(sqlCount)
        #expect(!newSQL.contains { $0.hasPrefix("CREATE ROLE") })
        #expect(newSQL.contains { $0.hasPrefix("ALTER ROLE \"vision_native_owner\"") })
    }

    @Test func occupiedPostgresPortFailsClosed() async throws {
        let harness = try Harness()
        harness.ports.occupy(54331)
        let error = await #expect(throws: NativeRuntimeError.self) { try await harness.makeRuntime().start() }
        #expect(error?.code == "POSTGRES_PORT_COLLISION")
        #expect(harness.spawner.spawns.isEmpty)
    }

    @Test func serverForAnotherDataDirectoryIsAPortCollision() async throws {
        let harness = try Harness()
        harness.postgresRunning = true
        harness.reportedDataDirectory = "/Users/demo/Library/Application Support/Vision Demo/native/vision_demo/postgres/data"
        let error = await #expect(throws: NativeRuntimeError.self) { try await harness.makeRuntime().start() }
        #expect(error?.code == "POSTGRES_PORT_COLLISION")
        #expect(harness.spawner.spawns.isEmpty)
        #expect(harness.runner.calls(named: "pg_ctl").isEmpty)
    }

    @Test func occupiedBackendPortIsReportedForRepicking() async throws {
        let harness = try Harness()
        harness.ports.occupy(41_000)
        let error = await #expect(throws: NativeRuntimeError.self) { try await harness.makeRuntime().start() }
        #expect(error?.code == "PORT_COLLISION")
    }

    @Test func clusterFromAnotherMajorIsRejected() async throws {
        let harness = try Harness()
        harness.fileSystem.addFile("\(harness.layout.postgresData)/PG_VERSION", "17\n")
        let error = await #expect(throws: NativeRuntimeError.self) { try await harness.makeRuntime().start() }
        #expect(error?.code == "POSTGRES_DATA_WRONG_VERSION")
        #expect(harness.runner.calls(named: "initdb").isEmpty)
    }

    @Test func interruptedInitializationIsQuarantined() async throws {
        let harness = try Harness()
        harness.fileSystem.addFile("\(harness.layout.postgresData)/base/partial", "x")
        _ = try await harness.makeRuntime().start()
        let quarantined = harness.fileSystem.paths(withPrefix: "\(harness.layout.postgresRoot)/data.incomplete-")
        #expect(quarantined.contains { $0.hasSuffix("/base/partial") })
        #expect(harness.fileSystem.text("\(harness.layout.postgresData)/PG_VERSION") == "18\n")
    }

    @Test func failedInitdbKeepsTheFailedStagingCopy() async throws {
        let harness = try Harness()
        let respond = harness.runner.handler
        harness.runner.handler = { call in
            if call.name == "initdb" {
                _ = try respond(call)
                throw FakeProcessFailure()
            }
            return try respond(call)
        }
        await #expect(throws: FakeProcessFailure.self) { try await harness.makeRuntime().start() }
        #expect(!harness.fileSystem.exists("\(harness.layout.postgresData)/PG_VERSION"))
        #expect(!harness.fileSystem.paths(withPrefix: "\(harness.layout.postgresRoot)/data.failed-").isEmpty)
        #expect(harness.fileSystem.paths(withPrefix: "/tmp/").isEmpty)
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

    @Test func cooperativeBackendOnlyGetsTerm() async throws {
        let harness = try Harness()
        _ = try await harness.makeRuntime().start()
        try await harness.makeRuntime().stopBackend()
        #expect(harness.processes.sentSignals.map { $0.1 } == [SIGTERM])
    }

    @Test func stopPostgresUsesFastShutdownOnOurDataDirectory() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        try await runtime.stop(keepPostgres: false)
        let pgCtl = try #require(harness.runner.calls(named: "pg_ctl").last)
        #expect(pgCtl.arguments == ["-D", harness.layout.postgresData, "-m", "fast", "-w", "-t", "30", "stop"])
        #expect(!harness.postgresRunning)
        #expect(!harness.fileSystem.exists(harness.layout.postgresPid))
    }

    @Test func keepPostgresLeavesTheClusterRunning() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        _ = try await runtime.start()
        try await runtime.stop(keepPostgres: true)
        #expect(harness.runner.calls(named: "pg_ctl").isEmpty)
        #expect(harness.postgresRunning)
    }

    @Test func stopWithoutAClusterIsANoOp() async throws {
        let harness = try Harness()
        try await harness.makeRuntime().stop(keepPostgres: false)
        #expect(harness.runner.calls.isEmpty)
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

    @Test func backendLogTailIsRedacted() async throws {
        let harness = try Harness()
        harness.fileSystem.addFile(
            harness.layout.backendLog, "boot\nDATABASE_URL=postgresql://vision_native_app:abcdef@127.0.0.1/x\n")
        let tail = try await harness.makeRuntime().backendLogTail()
        #expect(tail.contains("vision_native_app:***@"))
        #expect(!tail.contains("abcdef"))
    }
}
