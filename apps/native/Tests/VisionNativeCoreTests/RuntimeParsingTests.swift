import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct ChildEnvironmentTests {
    @Test func safeEnvironmentCarriesOnlyAllowlistedKeysPlusOverrides() {
        let environment = ChildEnvironment.safe(
            inherited: [
                "PATH": "/usr/bin:/custom/bin",
                "HOME": "/Users/demo",
                "VISION_TEST_SECRET": "must-not-leak",
                "OPENAI_API_KEY": "host-key",
            ],
            overrides: [("PORT", "3456"), ("SKIPPED", nil)])
        #expect(environment["PORT"] == "3456")
        #expect(environment["HOME"] == "/Users/demo")
        #expect(environment["VISION_TEST_SECRET"] == nil)
        #expect(environment["OPENAI_API_KEY"] == nil)
        #expect(environment["SKIPPED"] == nil)
        #expect(environment["PATH"] == "/usr/bin:/custom/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
    }

    @Test func theDatabaseToolRunsTheBackendAsBunWithoutDotenv() throws {
        let layout = try RuntimeLayout(userDataDirectory: testUserData)
        let environment = ChildEnvironment.databaseTool(
            inherited: ["PATH": "/usr/bin", "HOME": testHome, "FRED_API_KEY": "host"], layout: layout,
            runtimeRoot: testRuntimeRoot)
        #expect(environment["BUN_BE_BUN"] == "1")
        #expect(environment["VISION_SKIP_DOTENV"] == "1")
        #expect(environment["NODE_ENV"] == "production")
        #expect(environment["VISION_RUNTIME_ROOT"] == testRuntimeRoot)
        #expect(environment["VISION_DATABASE_PATH"] == layout.database)
        #expect(environment["HOME"] == testHome)
        #expect(environment["FRED_API_KEY"] == nil)
    }

    @Test func theBackendGetsTheMacsTimeZoneUnlessRuntimeEnvPinsOne() throws {
        let layout = try RuntimeLayout(userDataDirectory: testUserData)
        let system = ChildEnvironment.backend(
            inherited: [:], runtimeEnvironment: [:], port: 1, layout: layout, runtimeRoot: "/r",
            timeZone: "Europe/Helsinki")
        #expect(system["APP_TIMEZONE"] == "Europe/Helsinki")
        let pinned = ChildEnvironment.backend(
            inherited: [:], runtimeEnvironment: ["APP_TIMEZONE": "Europe/Brussels"], port: 1, layout: layout,
            runtimeRoot: "/r", timeZone: "Europe/Helsinki")
        #expect(pinned["APP_TIMEZONE"] == "Europe/Brussels")
        let unknown = ChildEnvironment.backend(
            inherited: [:], runtimeEnvironment: [:], port: 1, layout: layout, runtimeRoot: "/r", timeZone: nil)
        #expect(unknown["APP_TIMEZONE"] == nil)
        #expect(ChildEnvironment.systemTimeZone(TimeZone(identifier: "Europe/Helsinki")!) == "Europe/Helsinki")
    }

    @Test func backendEnvironmentPinsDataMigrationsAndLoopback() throws {
        let layout = try RuntimeLayout(userDataDirectory: testUserData)
        let environment = ChildEnvironment.backend(
            inherited: ["PATH": "/usr/bin", "AWS_SECRET_ACCESS_KEY": "leak"],
            runtimeEnvironment: [
                "DATABASE_URL": "postgresql://vision_native_app:x@127.0.0.1:54331/vision_native",
                "VISION_POSTGRES_ADMIN_PASSWORD": "retired",
                "FRED_API_KEY": "kept",
                "OPENAI_API_ENABLED": "true",
                "OPENAI_API_KEY": "synthetic-key",
                "AI_REFERENCE_MAPPING_KEY": "synthetic-mapping-key",
                "VISION_SYNTHETIC_SMOKE_OFFLINE": "1",
            ],
            port: 43123,
            layout: layout,
            runtimeRoot: testRuntimeRoot)
        #expect(environment["SERVER_HOST"] == "127.0.0.1")
        #expect(environment["PORT"] == "43123")
        #expect(environment["NODE_ENV"] == "production")
        #expect(environment["ENVIRONMENT"] == "production")
        #expect(environment["VISION_RUNTIME_ROOT"] == testRuntimeRoot)
        #expect(environment["VISION_DIST_DIR"] == "\(testRuntimeRoot)/dist")
        #expect(environment["VISION_NATIVE_ENV_FILE"] == layout.env)
        #expect(environment["ATTACHMENTS_DIR"] == layout.attachments)
        #expect(environment["OLLAMA_URL"] == "http://127.0.0.1:11434")
        #expect(environment["FRED_API_KEY"] == "kept")
        #expect(environment["VISION_DATABASE_PATH"] == layout.database)
        // The database server's settings are retired: they never reach the backend.
        #expect(environment["DATABASE_URL"] == nil)
        #expect(environment["VISION_POSTGRES_ADMIN_PASSWORD"] == nil)
        #expect(environment["AWS_SECRET_ACCESS_KEY"] == nil)
        // The migrations run in the backend from the payload; no tool paths are passed.
        for removed in [
            "ALEMBIC_BIN", "ALEMBIC_CONFIG", "PUPPETEER_EXECUTABLE_PATH", "VISION_AUDIT_BRIDGE_TOKEN",
            "VISION_SYNTHETIC_SMOKE_OFFLINE",
        ] {
            #expect(environment[removed] == nil, Comment(rawValue: removed))
        }
    }

    @Test func retiredSecretsNeverReachTheBackend() throws {
        let layout = try RuntimeLayout(userDataDirectory: testUserData)
        let environment = ChildEnvironment.backend(
            inherited: [:],
            runtimeEnvironment: [
                "OPENAI_API_ENABLED": "false", "OPENAI_API_KEY": "synthetic-key", "AI_REFERENCE_MAPPING_KEY": "k",
                "KEPT": "1",
            ],
            port: 1, layout: layout, runtimeRoot: "/r")
        for retired in ["OPENAI_API_ENABLED", "OPENAI_API_KEY", "AI_REFERENCE_MAPPING_KEY"] {
            #expect(environment[retired] == nil, Comment(rawValue: retired))
        }
        #expect(environment["KEPT"] == "1")
        #expect(ChildEnvironment.withoutRetired(["OPENAI_API_KEY": "x", "A": "b"]) == ["A": "b"])
    }
}

@Suite struct EnvFileTests {
    @Test func runtimeNamesNormalizeTheRuntimeId() throws {
        let names = try RuntimeNames(runtimeId: VisionNativeIdentity.runtimeId)
        #expect(names.id == "vision_native")
        #expect(try RuntimeNames.normalize("Vision-Demo") == "vision_demo")
        #expect(throws: NativeRuntimeError.self) { try RuntimeNames.normalize("1vision") }
    }

    @Test func parsingSkipsCommentsBlankLinesAndInvalidKeys() {
        let parsed = RuntimeEnvFile.parse("# comment\n\nA_B=1=2\nlower=x\n=bad\n  SPACED = value \r\n")
        #expect(parsed == ["A_B": "1=2", "SPACED": " value"])
    }

    @Test func retiredKeysAreStrippedLineByLine() {
        let contents =
            "A=1\nOPENAI_API_KEY=sk-x\n  AI_REFERENCE_MAPPING_KEY = y\nOPENAI_API_ENABLED=true\n"
            + "DATABASE_URL=postgresql://x\nVISION_POSTGRES_ADMIN_ROLE=admin\nB=2"
        #expect(RuntimeEnvFile.stripRetired(contents) == "A=1\nB=2")
        // Nothing to remove: the text is returned unchanged.
        #expect(RuntimeEnvFile.stripRetired("A=1\r\nB=2\n") == "A=1\r\nB=2\n")
    }

    @Test func onlyTheMarketDataKeysAreImported() throws {
        let additions = try RuntimeEnvFile.validateApplicationEnvironment([
            "FRED_API_KEY": "fred", "TWELVE_DATA_API_KEY": "twelve", "OPENAI_API_KEY": "no", "FMP_API_KEY": "",
            "PATH": "/bin",
        ])
        #expect(additions.map(\.0) == ["TWELVE_DATA_API_KEY", "FRED_API_KEY"])
        let contents = RuntimeEnvFile.importing(additions, into: RuntimeEnvFile.header + "FRED_API_KEY=old\nX=1")
        #expect(contents == RuntimeEnvFile.header + "FRED_API_KEY=fred\nX=1\nTWELVE_DATA_API_KEY=twelve\n")
        #expect(throws: NativeRuntimeError.self) {
            try RuntimeEnvFile.validateApplicationEnvironment(["FRED_API_KEY": "a\nDATABASE_URL=x"])
        }
    }

    @Test func importingWritesTheRuntimeEnvPrivately() async throws {
        let harness = try Harness()
        let runtime = try harness.makeRuntime()
        try await runtime.ensureLayout()
        let imported = try await runtime.importApplicationEnvironment(["FINNHUB_API_KEY": "abc", "HOME": "/x"])
        #expect(imported == ["FINNHUB_API_KEY"])
        #expect(harness.fileSystem.text(harness.layout.env) == RuntimeEnvFile.header + "FINNHUB_API_KEY=abc\n")
        #expect(try harness.fileSystem.mode(harness.layout.env) == 0o600)
    }
}

@Suite struct RuntimeLogAndSwitchTests {
    @Test func thePackagedMigrationVersionIsTheHighestNumberedMigration() throws {
        let fileSystem = FakeFileSystem()
        let directory = "/runtime/db/migrations"
        #expect(try MigrationLedger.packagedVersion(migrationsDirectory: directory, fileSystem: fileSystem) == 0)
        for name in ["0001_baseline.sql", "0003_holdings.sql", "0004_x.down.sql", "0002_b.sql", "0009.sql", "notes.md"] {
            fileSystem.addFile("\(directory)/\(name)", "--\n")
        }
        #expect(try MigrationLedger.packagedVersion(migrationsDirectory: directory, fileSystem: fileSystem) == 3)
    }

    @Test func theBackendsStartupErrorIsReadFromItsLog() {
        let log = [
            #"2026-10-19T18:45:41.511Z [ERROR] Failed to start application {"error":"old"}"#,
            #"2026-10-19T18:45:42.511Z [INFO] migration failed {"migration":"0001_baseline"}"#,
            #"2026-10-19T18:45:42.512Z [ERROR] Failed to start application {"error":"new"}"#,
            "",
        ].joined(separator: "\n")
        #expect(BackendLog.lastStartupError(log) == "new")
        #expect(BackendLog.lastStartupFailure(log) == BackendStartupFailure(message: "new"))
        #expect(BackendLog.lastStartupError("2026-10-19T09:21:00.000Z [INFO] ready\n") == nil)
        #expect(BackendLog.lastStartupError("[ERROR] Failed to start application {broken") == nil)
        #expect(
            BackendLog.lastStartupFailure(
                #"[ERROR] Failed to start application {"error":"disk full","code":"PRE_MIGRATION_BACKUP_FAILED"}"#)
                == BackendStartupFailure(message: "disk full", code: BackendStartupFailure.preMigrationBackupFailedCode))
        #expect(
            BackendLog.lastStartupFailure(#"[ERROR] Failed to start application {"error":"x","code":""}"#)
                == BackendStartupFailure(message: "x"))
    }

    @Test func switchRecoveryClassifiesEveryInterruptionPoint() {
        #expect(DatabaseSwitchState.classify(liveExists: true, previousExists: false) == .beforeRenames)
        #expect(DatabaseSwitchState.classify(liveExists: false, previousExists: true) == .betweenRenames)
        #expect(DatabaseSwitchState.classify(liveExists: true, previousExists: true) == .activated)
        #expect(DatabaseSwitchState.classify(liveExists: false, previousExists: false) == .unsafe)
    }
}

@Suite struct HealthAndSettingsTests {
    private func json(_ text: String) -> JSONValue { try! JSONValue.parse(Data(text.utf8)) }

    @Test func detailedReadinessRequiresTheDatabaseConnection() {
        #expect(HealthReadiness.isDetailedReady(json(#"{"database":{"connected":true}}"#)))
        #expect(!HealthReadiness.isDetailedReady(json(#"{"database":{"connected":false}}"#)))
        #expect(!HealthReadiness.isDetailedReady(json(#"{"database":{"connected":"true"}}"#)))
        #expect(!HealthReadiness.isDetailedReady(json("{}")))
        #expect(!HealthReadiness.isDetailedReady(nil))
    }

    @Test func navigationReadinessFollowsPingReady() {
        func ready(_ status: Int, _ body: String) -> Bool? {
            HealthReadiness.navigationReadiness(status: status, body: Data(body.utf8))
        }
        #expect(ready(404, "") == true)
        #expect(ready(503, "{}") == nil)
        #expect(ready(200, "not json") == true)
        #expect(ready(200, "null") == true)
        #expect(ready(200, #"{"status":"ready"}"#) == true)
        #expect(ready(200, #"{"status":"warming","caches":{"materializedViews":true}}"#) == true)
        #expect(ready(200, #"{"status":"warming","caches":{"materializedViews":false}}"#) == false)
    }

    @Test func persistedAppPortUsesJavaScriptNumberSemantics() {
        func port(_ text: String) -> Int? { AppSettings.persistedAppPort(json(text).objectValue ?? [:]) }
        #expect(port(#"{"appPort": 51234}"#) == 51234)
        #expect(port(#"{"appPort": "51234"}"#) == 51234)
        #expect(port(#"{"appPort": 51234.5}"#) == nil)
        #expect(port(#"{"appPort": 80}"#) == nil)
        #expect(port(#"{"appPort": 70000}"#) == nil)
        #expect(port(#"{"appPort": null}"#) == nil)
        #expect(port(#"{"appPort": true}"#) == nil)
        #expect(port("{}") == nil)
    }

    @Test func randomPortSkipsBusyCandidatesAndFallsBack() async {
        let ports = FakePorts()
        ports.occupy(41_000)
        let random = FakeRandom()
        random.ports = [41_000, 42_000]
        #expect(await AppSettings.pickRandomFreePort(ports: ports, random: random) == 42_000)
        random.ports = [41_000]
        #expect(await AppSettings.pickRandomFreePort(ports: ports, random: random) == RuntimeConstants.defaultAppPort)
        #expect(ports.probed.count == 2 + RuntimeConstants.randomAppPortAttempts)
    }

    @Test func keepServicesPrefersTheDatabaseSetting() {
        #expect(
            AppSettings.keepServicesFromSettingsResponse(
                json(#"{"ok":true,"data":{"key":"services_settings","value":{"keepServicesOnQuit":true}}}"#)) == true)
        #expect(
            AppSettings.keepServicesFromSettingsResponse(json(#"{"ok":true,"data":{"value":{}}}"#)) == false)
        #expect(AppSettings.keepServicesFromSettingsResponse(json(#"{"ok":true,"data":{"value":"x"}}"#)) == nil)
        #expect(AppSettings.keepServicesFromSettings(["keepServicesOnQuit": .bool(true)]))
        #expect(!AppSettings.keepServicesFromSettings(["keepServicesOnQuit": .string("true")]))
    }

    @Test func diagnosticsDropColourCodes() {
        #expect(redactDiagnostics("plain \u{1B}[31mred\u{1B}[0m \u{1B}[1;32mbold\u{1B}[0m") == "plain red bold")
    }
}

@Suite struct RuntimeRecordTests {
    @Test func markerMergesKeepsCurrentFieldsAndRemovesUndefinedKeys() {
        let now = Date(timeIntervalSince1970: 0)
        let merged = RuntimeMarker.merged(
            current: ["activeRuntime": .string("native"), "pendingDatabaseSwitch": .object([:]), "runtimeId": .string("x")],
            runtimeId: "vision_native",
            set: ["activation": .string("demo-native")],
            remove: ["pendingDatabaseSwitch"],
            now: now)
        #expect(merged["version"] == .int(1))
        #expect(merged["runtimeId"] == .string("x"))
        #expect(merged["activeRuntime"] == .string("native"))
        #expect(merged["activation"] == .string("demo-native"))
        #expect(merged["pendingDatabaseSwitch"] == nil)
        #expect(merged["updatedAt"] == .string("1970-01-01T00:00:00.000Z"))
        #expect(RuntimeMarker.isNativeActive(merged))
        #expect(!RuntimeMarker.isNativeActive(["activeRuntime": .string("docker")]))
    }

    @Test func onlyProbeablePIDsAreTrusted() {
        #expect(PIDRecord.recordedPID(Data(#"{"pid": 4242}"#.utf8)) == 4242)
        for text in [#"{"pid": 1}"#, #"{"pid": 0}"#, #"{"pid": -5}"#, #"{"pid": "4242"}"#, #"{"pid": 1.5}"#, "garbage"] {
            #expect(PIDRecord.recordedPID(Data(text.utf8)) == nil, "\(text)")
        }
        #expect(PIDRecord.recordedPID(nil) == nil)
    }

    @Test func backendOwnershipRequiresOurExecutable() {
        let backend = "/Applications/Vision Native.app/Contents/Resources/runtime/vision-backend"
        #expect(PIDRecord.commandMatchesBackend(psOutput: "\(backend)\n", backendExecutable: backend))
        #expect(!PIDRecord.commandMatchesBackend(psOutput: "/usr/bin/vim notes.txt", backendExecutable: backend))
        #expect(!PIDRecord.commandMatchesBackend(psOutput: "", backendExecutable: backend))
    }

    @Test func layoutStaysInsideVisionNativesOwnDirectory() throws {
        let layout = try RuntimeLayout(userDataDirectory: testUserData)
        #expect(layout.nativeRoot == "\(testUserData)/native/vision_native")
        #expect(layout.env == "\(testUserData)/native/vision_native/runtime.env")
        #expect(layout.state == "\(testUserData)/native/vision_native/runtime-state.json")
        #expect(layout.pid == "\(testUserData)/native/vision_native/backend.pid.json")
        // The database lives beside the runtime directory: the whole directory is one generation.
        #expect(layout.databaseDirectory == "\(testUserData)/database")
        #expect(layout.database == "\(testUserData)/database/vision.sqlite3")
        #expect(layout.backendLog == "\(testUserData)/native/vision_native/logs/backend.log")
        #expect(layout.settings == "\(testUserData)/settings.json")
        #expect(VisionNativeIdentity.userDataDirectory(homeDirectory: testHome) == testUserData)
        for foreign in ["Vision", "Vision Demo", "Vision Development", "Other"] {
            #expect(throws: NativeRuntimeError.self) {
                try RuntimeLayout(userDataDirectory: "\(testHome)/Library/Application Support/\(foreign)")
            }
        }
    }
}

@Suite struct DatabaseStatsTests {
    @Test func parsesTheSqliteHeader() throws {
        let header = try DatabaseStatistics.parseHeader(sqliteDatabase(userVersion: 130, pages: 5))
        #expect(header.pageSize == 4096)
        #expect(header.journalMode == .wal)
        #expect(header.pageCount == 5)
        #expect(header.textEncoding == .utf8)
        #expect(header.userVersion == 130)
        #expect(DatabaseStatistics.sqliteVersionString(header.sqliteVersionNumber) == "3.43.2")
    }

    @Test func rejectsFilesThatAreNotSqlite() {
        var badPageSize = [UInt8](sqliteDatabase(userVersion: 1))
        badPageSize[16] = 0x03
        badPageSize[17] = 0x00
        for data in [Data("PGDMP".utf8), Data(sqliteDatabase(userVersion: 1).prefix(99)), Data(badPageSize)] {
            #expect(throws: NativeRuntimeError.self) { try DatabaseStatistics.parseHeader(data) }
        }
    }

    @Test func fileStatsReportMissingEmptyAndUnsafePaths() throws {
        let fileSystem = FakeFileSystem()
        let path = "\(testUserData)/database/vision.sqlite3"
        #expect(try DatabaseStatistics.readFileStats(path, fileSystem: fileSystem).exists == false)
        fileSystem.addFile(path, Data())
        let empty = try DatabaseStatistics.readFileStats(path, fileSystem: fileSystem)
        #expect(empty.exists && empty.schemaVersion == 0)
        fileSystem.addFile(path, sqliteDatabase(userVersion: 3, body: "x"))
        fileSystem.addFile("\(path)-wal", "wal")
        let stats = try DatabaseStatistics.readFileStats(path, fileSystem: fileSystem)
        #expect(stats.schemaVersion == 3)
        #expect(stats.walBytes == 3)
        #expect(stats.sqliteVersion == "3.43.2")
        #expect(DatabaseStatistics.describe(stats).contains("schema=3"))
    }

    @Test func stableComparisonIgnoresStartupWrittenSettings() throws {
        let expected = ["accounts": 3, "user_settings": 1]
        let actual = ["accounts": 3, "user_settings": 4]
        #expect(!DatabaseStatistics.stableTables.contains("user_settings"))
        #expect(throws: Never.self) {
            try DatabaseStatistics.assertTableCountsEqual(
                expected: expected, actual: actual, tables: DatabaseStatistics.stableTables)
        }
        do {
            try DatabaseStatistics.assertTableCountsEqual(expected: expected, actual: actual)
            Issue.record("expected DATABASE_COUNT_MISMATCH")
        } catch let error as NativeRuntimeError {
            #expect(error.code == "DATABASE_COUNT_MISMATCH")
            #expect(error.message.contains("user_settings: expected 1, found 4"))
        }
    }
}
