import Darwin
import Foundation

/// How a backend start ended (`StartResult`).
public enum BackendStartResult: Sendable, Equatable {
    case alreadyRunning(pid: Int32, port: Int)
    case started(pid: Int32, port: Int, database: String)
}

/// Where an interrupted database switch stopped (`classifyDatabaseSwitchState`).
public enum DatabaseSwitchState: Sendable, Equatable {
    case activated
    case betweenRenames
    case beforeRenames
    case unsafe

    public static func classify(liveExists: Bool, previousExists: Bool) -> DatabaseSwitchState {
        switch (liveExists, previousExists) {
        case (true, true): return .activated
        case (false, true): return .betweenRenames
        case (true, false): return .beforeRenames
        case (false, false): return .unsafe
        }
    }
}

/// Supervises Vision Native's packaged Bun backend over one SQLite database file (ADR-263).
/// A port of `createNativeRuntime` in `packaging/electron/runtime/native.ts`: layout,
/// `runtime.env`, payload discovery, the backend child, PID ownership, health, the database
/// tool (`verify`, `snapshot`, `create`), the database generation switch used by Demo
/// seeding and restore, and the attachment switch used by backup and restore. The backend
/// opens the database itself and applies pending migrations at boot, after writing its own
/// pre-migration copy.
public actor NativeRuntime: DemoSeedingRuntime, BackupRuntime {
    public nonisolated let layout: RuntimeLayout
    public nonisolated let names: RuntimeNames
    /// The verified payload root (`VISION_RUNTIME_ROOT` for the backend).
    public nonisolated let runtimeRoot: String

    private let inheritedEnvironment: [String: String]
    private let dependencies: RuntimeDependencies
    /// `recordBootPhase`: receives named startup timings, such as the payload verification.
    private let recordBootPhase: (@Sendable (String, Int) -> Void)?
    /// The in-process Swift backend's connection (ADR-270): suspended while Bun is stopped,
    /// so no snapshot, restore or switch runs with a second writer on the file.
    private let databaseHolder: (any InProcessDatabaseHolder)?
    private var appPort: Int
    private var tools: NativeTools?
    private var backendChild: SpawnedChild?
    private var shuttingDown = false
    /// The staging generation of an activation whose switch plan is not persisted yet.
    private var stagingRestoreDirectory: String?
    /// `restoreSwitchOwnedThisLaunch`: this launch persisted the pending database switch,
    /// so the launch recovery must not treat it as an interrupted one and roll it back.
    private var restoreSwitchOwnedThisLaunch = false
    /// `startupRestoreRecovery`: the one coordinated recovery per launch. A failure stays
    /// memoized, so every later start fails closed too.
    private var startupRestoreRecovery: Task<Void, Error>?

    public init(
        layout: RuntimeLayout,
        runtimeRoot: String,
        appPort: Int,
        inheritedEnvironment: [String: String],
        dependencies: RuntimeDependencies,
        recordBootPhase: (@Sendable (String, Int) -> Void)? = nil,
        databaseHolder: (any InProcessDatabaseHolder)? = nil
    ) throws {
        self.recordBootPhase = recordBootPhase
        self.databaseHolder = databaseHolder
        self.layout = layout
        names = try RuntimeNames(runtimeId: layout.runtimeId)
        self.runtimeRoot = PathUtilities.normalize(runtimeRoot)
        self.appPort = appPort
        self.inheritedEnvironment = inheritedEnvironment
        self.dependencies = dependencies
    }

    // MARK: - Helpers

    private var fileSystem: any RuntimeFileSystem { dependencies.fileSystem }
    private var host: String { RuntimeConstants.loopbackHost }

    private func now() -> Date { dependencies.clock.now() }

    private func nowMilliseconds() -> Int { epochMilliseconds(now()) }

    private func safeEnvironment(_ overrides: [(String, String?)] = []) -> [String: String] {
        ChildEnvironment.safe(inherited: inheritedEnvironment, overrides: overrides)
    }

    private func run(
        _ executable: String,
        _ arguments: [String],
        timeout: TimeInterval = 30,
        environment: [String: String]? = nil,
        cwd: String? = nil
    ) async throws -> RunResult {
        try await dependencies.runner.run(
            executable, arguments,
            options: RunOptions(cwd: cwd, environment: environment ?? safeEnvironment(), timeout: timeout))
    }

    private func requireTools() throws -> NativeTools {
        guard let tools else {
            throw NativeRuntimeError("TOOLS_NOT_DISCOVERED", "Native runtime tools are not discovered")
        }
        return tools
    }

    private func ensureDiscovered() async throws {
        if tools == nil { try await discover() }
    }

    public var currentAppPort: Int { appPort }

    /// From now on refuses to spawn the backend and to begin a database switch, so a launch
    /// that is still running cannot start anything behind a quit.
    public func beginShutdown() {
        shuttingDown = true
    }

    private func ensureNotShuttingDown() throws {
        if shuttingDown {
            throw NativeRuntimeError("SHUTTING_DOWN", "Vision Native is quitting.")
        }
    }

    public func setAppPort(_ port: Int) {
        appPort = port
    }

    // MARK: - Layout and discovery

    /// `ensureLayout`: private directories (the database directory included), then
    /// `runtime.env`, created with the header alone or stripped of the settings of removed
    /// features (the database server's credentials among them).
    public func ensureLayout() async throws {
        for directory in [
            layout.nativeRoot, layout.logs, layout.attachments, layout.cache, layout.databaseDirectory,
        ] {
            try fileSystem.createDirectory(directory, mode: 0o700)
        }
        switch try readRuntimeEnv() {
        case .some(let existing):
            let upgraded = RuntimeEnvFile.stripRetired(existing)
            if upgraded != existing {
                try fileSystem.writeText(layout.env, upgraded, mode: 0o600)
            } else {
                try fileSystem.setMode(layout.env, 0o600)
            }
        case .none:
            try fileSystem.writeText(layout.env, RuntimeEnvFile.header, mode: 0o600)
        }
    }

    /// `runtime.env` holds the market-data keys, so it is read without following a symlink
    /// and must be a regular file; `nil` when it does not exist yet.
    private func readRuntimeEnv() throws -> String? {
        switch try fileSystem.readNoFollow(layout.env) {
        case .missing:
            return nil
        case .unsafe:
            throw NativeRuntimeError("INVALID_RUNTIME_ENV", "Native runtime.env is not a regular file")
        case .contents(let data):
            return String(decoding: data, as: UTF8.self)
        }
    }

    /// `importApplicationEnv`: copies the market-data keys of `values` into `runtime.env`.
    /// Returns the imported keys.
    @discardableResult
    public func importApplicationEnvironment(_ values: [String: String]) async throws -> [String] {
        let additions = try RuntimeEnvFile.validateApplicationEnvironment(values)
        let contents = try readRuntimeEnv() ?? RuntimeEnvFile.header
        try fileSystem.writeText(layout.env, RuntimeEnvFile.importing(additions, into: contents), mode: 0o600)
        return additions.map(\.0)
    }

    /// `discover`: verifies the payload manifest (a full hash once per installed payload, a
    /// size check afterwards, ADR-235) off the actor and finds the compiled backend.
    @discardableResult
    public func discoverTools() async throws -> NativeTools {
        let started = Date()
        let recorder = recordBootPhase
        let root = runtimeRoot
        let marker = PathUtilities.join(layout.nativeRoot, RuntimeConstants.runtimeVerificationMarker)
        let fileSystem = self.fileSystem
        let discovered = try await runBlocking {
            try RuntimePayload.discoverTools(
                runtimeRoot: root, markerPath: marker, fileSystem: fileSystem,
                verification: { mode in
                    recorder?("runtime_manifest_\(mode.rawValue)", Int(Date().timeIntervalSince(started) * 1000))
                })
        }
        tools = discovered
        return discovered
    }

    public func discover() async throws {
        try await discoverTools()
    }

    /// `recoverOnce`: the coordinated launch recovery, at most once per launch and never
    /// for a switch this launch owns.
    private func recoverOnce() async throws {
        if restoreSwitchOwnedThisLaunch { return }
        let recovery = startupRestoreRecovery ?? Task { try await self.recoverInterruptedRestore() }
        startupRestoreRecovery = recovery
        try await recovery.value
    }

    /// `ensureDatabaseReady`: layout and interrupted-restore recovery before a backend opens
    /// the database.
    public func ensureDatabaseReady() async throws {
        try await ensureLayout()
        try await ensureDiscovered()
        try await recoverOnce()
    }

    // MARK: - Runtime marker

    /// `readState`: `nil` when the marker does not exist; a marker that is not a JSON
    /// object throws instead of reading as empty, so recovery never ignores a journal.
    public func readState() async throws -> [String: JSONValue]? {
        guard let data = try fileSystem.readIfPresent(layout.state) else { return nil }
        guard let state = try RuntimeMarker.parse(data) else {
            throw NativeRuntimeError("INVALID_RUNTIME_STATE", "Invalid native runtime state")
        }
        return state
    }

    public func writeState(set: [String: JSONValue], remove: [String]) async throws {
        let next = RuntimeMarker.merged(
            current: try await readState(), runtimeId: names.id, set: set, remove: remove, now: now())
        try fileSystem.writeFile(layout.state, try JSONValue.object(next).serialized(), mode: 0o600)
    }

    /// `assertNativeActive`.
    public func assertNativeActive() async throws {
        if RuntimeMarker.isNativeActive(try await readState()) { return }
        try await writeState(
            set: ["activeRuntime": .string("native"), "activation": .string("fresh-install")], remove: [])
    }

    // MARK: - Backend

    /// `health`: `GET http://127.0.0.1:<appPort>/health[/detailed]`, 200 with a JSON body.
    public func health(detailed: Bool = false, timeoutMilliseconds: Int = 2_000) async throws -> JSONValue {
        let path = detailed ? "/health/detailed" : "/health"
        guard let url = URL(string: "http://\(host):\(appPort)\(path)") else {
            throw NativeRuntimeError("HEALTH_URL_INVALID", "Invalid backend health URL")
        }
        let response = try await dependencies.http.get(url, timeout: Double(timeoutMilliseconds) / 1000)
        guard response.status == 200 else {
            throw NativeRuntimeError("HEALTH_HTTP_STATUS", "HTTP \(response.status)")
        }
        return try JSONValue.parse(response.body)
    }

    /// `waitUntilReady`: polls health; with `detailed` it also needs a connected database.
    @discardableResult
    public func waitUntilReady(attempts: Int = 200, intervalMilliseconds: Int = 300, detailed: Bool = false)
        async throws -> JSONValue
    {
        var lastError: Error?
        for _ in 0..<attempts {
            do {
                let result = try await health(
                    detailed: detailed, timeoutMilliseconds: max(1_000, intervalMilliseconds * 2))
                if !detailed || HealthReadiness.isDetailedReady(result) { return result }
            } catch {
                lastError = error
            }
            await dependencies.clock.sleep(milliseconds: intervalMilliseconds)
        }
        let suffix = lastError.map { ": \($0.localizedDescription)" } ?? ""
        throw NativeRuntimeError("BACKEND_NOT_READY", "Native backend readiness timed out\(suffix)")
    }

    /// `processMatchesBackend`: the live process's command line contains our backend.
    public func processMatchesBackend(_ pid: Int32) async -> Bool {
        guard dependencies.processes.exists(pid) else { return false }
        guard (try? await ensureDiscovered()) != nil, let backend = tools?.compiledBackend else { return false }
        let output = (try? await run("/bin/ps", ["-p", String(pid), "-o", "command="], timeout: 5))?.stdout ?? ""
        return PIDRecord.commandMatchesBackend(psOutput: output, backendExecutable: backend)
    }

    /// `start`: recovers an interrupted restore, reuses a healthy backend this runtime
    /// started earlier, refuses to touch a PID owned by another program, then spawns the
    /// compiled backend on the loopback app port with the allowlisted environment. The
    /// backend opens the SQLite file and applies pending migrations itself.
    /// Unlike Electron (`BACKEND_STALE_PID`), a recorded backend of ours that does not
    /// answer `/health` is stopped and replaced, so Retry can recover from it.
    @discardableResult
    public func start() async throws -> BackendStartResult {
        try await assertNativeActive()
        try await ensureDatabaseReady()
        let tools = try requireTools()
        if let existing = PIDRecord.recordedPID(try? fileSystem.readIfPresent(layout.pid)),
            dependencies.processes.exists(existing)
        {
            guard await processMatchesBackend(existing) else {
                throw NativeRuntimeError(
                    "BACKEND_PID_OWNERSHIP_MISMATCH",
                    "The recorded backend process id belongs to another process; refusing to signal it.")
            }
            if (try? await waitUntilReady(attempts: 3, intervalMilliseconds: 500)) != nil {
                await databaseHolder?.resume(databasePath: layout.database)
                return .alreadyRunning(pid: existing, port: appPort)
            }
            try await stopBackend()
        }
        try? fileSystem.remove(layout.pid)

        let port = appPort
        guard await dependencies.ports.isPortFree(port) else {
            throw NativeRuntimeError("PORT_COLLISION", "Native backend port \(port) is already in use.")
        }
        let runtimeEnvironment = RuntimeEnvFile.parse(try fileSystem.readText(layout.env))
        let environment = ChildEnvironment.backend(
            inherited: inheritedEnvironment,
            runtimeEnvironment: runtimeEnvironment,
            port: port,
            layout: layout,
            runtimeRoot: runtimeRoot)
        let recordPath = layout.pid
        let spawnedPID = LockedValue<Int32>(0)
        try ensureNotShuttingDown()
        let child = try dependencies.spawner.spawn(
            tools.compiledBackend, [], cwd: runtimeRoot, environment: environment, logPath: layout.backendLog,
            onExit: { [self] in
                let pid = spawnedPID.withLock { $0 }
                Task { await self.clearPIDRecord(recordPath, pid: pid) }
            })
        guard child.pid > 1 else {
            throw NativeRuntimeError("BACKEND_NOT_READY", "Native backend did not provide a process id")
        }
        spawnedPID.withLock { $0 = child.pid }
        backendChild = child
        try fileSystem.writeFile(
            recordPath,
            try PIDRecord.backend(
                pid: child.pid, port: port, runtimeId: names.id, command: tools.compiledBackend, now: now()
            ).serialized(),
            mode: 0o600)
        await databaseHolder?.resume(databasePath: layout.database)
        return .started(pid: child.pid, port: port, database: layout.database)
    }

    /// Removes a PID record only when it still names the exited process.
    private func clearPIDRecord(_ path: String, pid: Int32) {
        guard pid > 1, PIDRecord.recordedPID(try? fileSystem.readIfPresent(path)) == pid else { return }
        try? fileSystem.remove(path)
    }

    /// `stopBackend`: SIGTERM, up to `forceAfterMilliseconds` of grace, then SIGKILL, only
    /// for a recorded PID whose command line is our backend.
    /// The in-process connection is suspended first, so Bun's stop leaves no writer behind.
    public func stopBackend(forceAfterMilliseconds: Int = 10_000) async throws {
        await databaseHolder?.suspend()
        guard let recorded = PIDRecord.recordedPID(try? fileSystem.readIfPresent(layout.pid)),
            dependencies.processes.exists(recorded)
        else {
            try? fileSystem.remove(layout.pid)
            return
        }
        guard await processMatchesBackend(recorded) else {
            throw NativeRuntimeError(
                "BACKEND_PID_OWNERSHIP_MISMATCH",
                "The recorded backend process id belongs to another process; refusing to signal it.")
        }
        try dependencies.processes.signal(recorded, SIGTERM)
        let deadline = now().addingTimeInterval(Double(forceAfterMilliseconds) / 1000)
        while dependencies.processes.exists(recorded) && now() < deadline {
            await dependencies.clock.sleep(milliseconds: 100)
        }
        if dependencies.processes.exists(recorded) {
            try dependencies.processes.signal(recorded, SIGKILL)
            // A writer that is still alive would make a quiescent snapshot inconsistent.
            let killedDeadline = now().addingTimeInterval(10)
            while dependencies.processes.exists(recorded) && now() < killedDeadline {
                await dependencies.clock.sleep(milliseconds: 50)
            }
            if dependencies.processes.exists(recorded) {
                throw NativeRuntimeError(
                    "BACKEND_STOP_FAILED", "Native backend did not stop; snapshot capture is unsafe")
            }
        }
        try? fileSystem.remove(layout.pid)
    }

    /// `stop`: the backend, the only process that holds the database open.
    public func stop() async throws {
        try await stopBackend()
    }

    /// `restart`.
    @discardableResult
    public func restart() async throws -> BackendStartResult {
        try await stop()
        return try await start()
    }

    /// The last lines of `backend.log`, without colour codes, for the app log after a failed start.
    public func backendLogTail(lines: Int = 200) -> String {
        guard let data = try? fileSystem.readIfPresent(layout.backendLog) else { return "" }
        let text = String(decoding: data, as: UTF8.self)
        return redactDiagnostics(text.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines)
            .joined(separator: "\n"))
    }

    /// `backendStartupFailure`: why the backend from the last `start()` exited, or `nil`
    /// while it runs (or when none was started), so a launch can show the reason instead of
    /// polling until it times out. Unlike Electron it has no exit code to report.
    public func backendStartupFailure() -> BackendStartupFailure? {
        guard backendChild?.hasExited() == true else { return nil }
        let data = try? fileSystem.readIfPresent(layout.backendLog)
        let tail = data.map { String(decoding: $0.suffix(65_536), as: UTF8.self) } ?? ""
        return BackendLog.lastStartupFailure(tail)
            ?? BackendStartupFailure(message: "The Vision backend stopped during startup.")
    }

    // MARK: - Database tool

    /// `runDatabaseTool`: `tools/db-file.js` through the packaged backend executable acting
    /// as Bun, so the tool uses the same Bun and SQLite as the backend. A failure carries the
    /// tool's own JSON error when it printed one.
    private func runDatabaseTool(_ command: DatabaseTool) async throws -> DatabaseFileReport {
        try await ensureDiscovered()
        let backend = try requireTools().compiledBackend
        let tool = PathUtilities.join(runtimeRoot, RuntimeConstants.packagedDatabaseTool)
        guard fileSystem.isExecutable(backend), fileSystem.info(tool) != nil else {
            throw NativeRuntimeError(
                "DATABASE_TOOL_MISSING", "Vision's database tool is missing from this installation. Reinstall Vision.")
        }
        let environment = ChildEnvironment.databaseTool(
            inherited: inheritedEnvironment, layout: layout, runtimeRoot: runtimeRoot)
        let stdout: String
        do {
            stdout = try await run(
                backend, [tool] + command.arguments, timeout: 30 * 60, environment: environment, cwd: runtimeRoot
            ).stdout
        } catch {
            let output = (error as? ProcessRunError)?.stdout ?? ""
            if case .failure(let message)? = try? DatabaseTool.parseOutput(output) {
                throw NativeRuntimeError(command.failureCode, message)
            }
            throw NativeRuntimeError(
                command.failureCode, "Vision's database tool failed: \(backupErrorMessage(error))")
        }
        switch try DatabaseTool.parseOutput(stdout) {
        case .report(let report)?:
            return report
        case .failure(let message)?:
            throw NativeRuntimeError(command.failureCode, message)
        case nil:
            throw NativeRuntimeError(command.failureCode, "Vision's database tool returned no result")
        }
    }

    /// `verifyDatabaseFile`: `integrity_check`, `foreign_key_check` and the migration
    /// ledger of a database file.
    public func verifyDatabaseFile(_ path: String) async throws -> DatabaseFileReport {
        try await runDatabaseTool(.verify(PathUtilities.normalize(path)))
    }

    /// `snapshotDatabase`: a consistent copy of the live database (`VACUUM INTO`, verified)
    /// at `destination`, written to a `.partial` sidecar and renamed only once the tool
    /// verified it, so a failure never leaves a file at the final name.
    public func snapshotDatabase(to destination: String) async throws -> DatabaseFileReport {
        try await ensureLayout()
        guard fileSystem.exists(layout.database) else {
            throw NativeRuntimeError("DATABASE_MISSING", "Vision has no database to back up yet.")
        }
        let finalPath = PathUtilities.normalize(destination)
        let partialPath = "\(finalPath).partial"
        try fileSystem.createDirectory(PathUtilities.dirname(finalPath), mode: 0o700)
        try? fileSystem.remove(partialPath)
        do {
            let report = try await runDatabaseTool(.snapshot(source: layout.database, destination: partialPath))
            try fileSystem.move(partialPath, finalPath)
            try fileSystem.setMode(finalPath, 0o600)
            return report.at(finalPath)
        } catch {
            try? fileSystem.remove(partialPath)
            throw error
        }
    }

    /// `createDatabaseFile`: a new database at the packaged migration head, optionally
    /// loaded with a data-only SQL file.
    public func createDatabaseFile(_ destination: String, seedSQL: String? = nil) async throws -> DatabaseFileReport {
        try await runDatabaseTool(
            .create(PathUtilities.normalize(destination), seedSQL: seedSQL.map(PathUtilities.normalize)))
    }

    /// `getDatabaseStats`: file statistics of the live database, read without the backend.
    public func getDatabaseStats() async throws -> DatabaseFileStats {
        try DatabaseStatistics.readFileStats(layout.database, fileSystem: fileSystem)
    }

    /// `getLocalMigrationVersion`: the newest migration in the payload's `db/migrations`;
    /// 0 when it has none or the directory cannot be read.
    public func packagedMigrationVersion() async -> Int {
        (try? MigrationLedger.packagedVersion(
            migrationsDirectory: PathUtilities.join(runtimeRoot, "db", "migrations"), fileSystem: fileSystem)) ?? 0
    }

    /// `pendingSchemaUpgrade`: the live database is behind this build's migrations, so the
    /// backend backs it up and migrates it at start. Version 0 is a database no migration
    /// has touched yet: nothing to back up.
    public func pendingSchemaUpgrade() async -> PendingSchemaUpgrade? {
        let packaged = await packagedMigrationVersion()
        guard let stats = try? DatabaseStatistics.readFileStats(layout.database, fileSystem: fileSystem),
            let databaseVersion = stats.schemaVersion, databaseVersion != 0, databaseVersion < packaged
        else { return nil }
        return PendingSchemaUpgrade(databaseVersion: databaseVersion, packagedVersion: packaged)
    }

    // MARK: - Database generation switch (Demo seeding and restore)

    private func generationNonce() -> String {
        "\(nowMilliseconds())-\(dependencies.random.hex(byteCount: 4))"
    }

    private func generationPath(_ kind: String, _ nonce: String) -> String {
        PathUtilities.join(layout.userDataDirectory, "\(RuntimeConstants.databaseDirectoryName).\(kind)-\(nonce)")
    }

    /// `switchTokenDirectories`: the three directories a persisted token names, after
    /// checking that they are this runtime's database generations, so a tampered or foreign
    /// token can never make the runtime rename an arbitrary directory.
    private func switchTokenDirectories(_ token: JSONValue) throws -> (live: String, previous: String, activated: String) {
        func generation(_ value: JSONValue?, _ kind: String) -> String? {
            guard let path = value?.stringValue, PathUtilities.dirname(path) == layout.userDataDirectory,
                PathUtilities.fullMatch(
                    PathUtilities.basename(path), "\(RuntimeConstants.databaseDirectoryName)\\.\(kind)-[0-9a-z-]{1,64}")
            else { return nil }
            return path
        }
        guard DatabaseSwitchToken.isSqliteToken(token),
            token["liveDirectory"] == .string(layout.databaseDirectory),
            let previous = generation(token["previousDirectory"], "previous"),
            let activated = generation(token["activatedDirectory"], "restore")
        else {
            throw NativeRuntimeError("NO_DATABASE_SWITCH", "No matching native database switch is available")
        }
        return (layout.databaseDirectory, previous, activated)
    }

    /// `activateRestoredDatabase`: stages the file as the next database generation, verifies
    /// the staged copy (integrity, foreign keys, ledger, and the expected checksum and schema
    /// version), then swaps generations with two directory renames journaled beforehand.
    /// Nothing live changes before the copy has passed verification; a failure after the
    /// journal is written puts the previous generation back.
    public func activateRestoredDatabase(_ path: String, expectedSchemaVersion: Int?, expectedSha256: String?)
        async throws -> DatabaseActivation
    {
        try await assertNativeActive()
        try await ensureLayout()
        try await ensureDiscovered()
        try await recoverOnce()
        let source = PathUtilities.normalize(path)
        guard let info = fileSystem.info(source), info.kind == .file, info.size > 0 else {
            throw NativeRuntimeError("INVALID_DATABASE_FILE", "The database to restore is empty or not a file")
        }
        let nonce = generationNonce()
        let staging = generationPath("restore", nonce)
        let previous = generationPath("previous", nonce)
        var token: DatabaseSwitchToken?
        try fileSystem.createDirectory(staging, mode: 0o700)
        stagingRestoreDirectory = staging
        do {
            let stagedFile = PathUtilities.join(staging, RuntimeConstants.databaseFileName)
            try fileSystem.copyFileDurably(source, stagedFile, mode: 0o600)
            let validation = try await verifyDatabaseFile(stagedFile)
            if let expectedSha256, validation.sha256 != expectedSha256 {
                throw NativeRuntimeError(
                    "DATABASE_CHECKSUM_MISMATCH",
                    "The database in the backup does not match its recorded checksum; the backup is corrupt.")
            }
            if let expectedSchemaVersion, validation.schemaVersion != expectedSchemaVersion {
                throw NativeRuntimeError(
                    "DATABASE_SCHEMA_MISMATCH", "Restored database schema revision does not match backup metadata")
            }
            try ensureNotShuttingDown()
            let plan = DatabaseSwitchToken(
                liveDirectory: layout.databaseDirectory, previousDirectory: previous, activatedDirectory: staging,
                activatedAt: isoTimestamp(now()))
            token = plan
            // Persist the complete rename plan before touching the live database. Recovery
            // can then tell every interruption point apart without creating a replacement
            // empty database or guessing which copy is live.
            try await writeState(set: ["pendingDatabaseSwitch": try JSONValue(encoding: plan)], remove: [])
            stagingRestoreDirectory = nil
            restoreSwitchOwnedThisLaunch = true
            try await stop()
            if fileSystem.exists(layout.databaseDirectory) {
                try fileSystem.move(layout.databaseDirectory, previous)
            }
            try fileSystem.move(staging, layout.databaseDirectory)
            fileSystem.syncDirectory(layout.userDataDirectory)
            return DatabaseActivation(switchToken: plan, validation: validation)
        } catch {
            if let token {
                do {
                    try await rollbackDatabaseSwitch(try JSONValue(encoding: token))
                } catch {
                    restoreSwitchOwnedThisLaunch = false
                    startupRestoreRecovery = nil
                    throw NativeRuntimeError(
                        "DATABASE_SWITCH_RECOVERY_FAILED",
                        "Native database activation failed and automatic rollback did not complete; Vision remains stopped."
                    )
                }
            } else {
                stagingRestoreDirectory = nil
                try? fileSystem.remove(staging)
            }
            throw error
        }
    }

    /// Removes the staging generation of an activation that a quit interrupted before its
    /// switch plan was persisted. A persisted plan is rolled back on the next launch.
    public func discardStagingRestore() {
        guard let staging = stagingRestoreDirectory else { return }
        stagingRestoreDirectory = nil
        try? fileSystem.remove(staging)
    }

    /// `rollbackDatabaseSwitch`: puts the previous generation back for every interruption
    /// point and preserves the failed one for inspection.
    public func rollbackDatabaseSwitch(_ token: JSONValue?) async throws {
        try await ensureLayout()
        var candidate = token
        if candidate == nil || candidate?.isTruthy == false {
            candidate = try await readState()?["pendingDatabaseSwitch"]
        }
        guard let switchToken = candidate, switchToken.isTruthy else {
            throw NativeRuntimeError("NO_DATABASE_SWITCH", "No matching native database switch is available")
        }
        let (live, previous, activated) = try switchTokenDirectories(switchToken)
        try await stop()
        // ensureLayout recreates an empty live directory; only a database file inside it
        // makes the live generation real.
        let liveExists = fileSystem.exists(PathUtilities.join(live, RuntimeConstants.databaseFileName))
        let previousExists = fileSystem.exists(previous)
        let activatedExists = fileSystem.exists(activated)
        let state = DatabaseSwitchState.classify(liveExists: liveExists, previousExists: previousExists)
        if state == .unsafe {
            throw NativeRuntimeError(
                "DATABASE_SWITCH_UNSAFE",
                "Neither the live nor previous native database exists; automatic rollback is unsafe")
        }
        var preservedFailed: String? = activatedExists ? activated : nil
        if state == .activated || state == .betweenRenames {
            let failed = generationPath("failed", generationNonce())
            // The live directory exists in both states: as the activated generation, or as
            // the empty directory a layout check recreated.
            let liveDirectoryExists = fileSystem.exists(live)
            if liveDirectoryExists { try fileSystem.move(live, failed) }
            do {
                try fileSystem.move(previous, live)
            } catch {
                if liveDirectoryExists { try? fileSystem.move(failed, live) }
                throw error
            }
            fileSystem.syncDirectory(layout.userDataDirectory)
            if state == .activated {
                preservedFailed = failed
            } else {
                try? fileSystem.remove(failed)
            }
        }
        var rollback: [String: JSONValue] = [
            "restoredDatabase": .string(state == .beforeRenames ? live : previous),
            "rolledBackAt": .string(isoTimestamp(now())),
        ]
        if let preservedFailed { rollback["preservedFailedDatabase"] = .string(preservedFailed) }
        try await writeState(set: ["lastRollback": .object(rollback)], remove: ["pendingDatabaseSwitch"])
        restoreSwitchOwnedThisLaunch = false
        startupRestoreRecovery = nil
    }

    /// `prunePreviousDatabaseGenerations`: keeps the newest previous generations.
    private func prunePreviousDatabaseGenerations() throws {
        let prefix = "\(RuntimeConstants.databaseDirectoryName).previous-"
        struct Generation {
            let path: String
            let modified: Date
        }
        let root = layout.userDataDirectory
        var generations: [Generation] = []
        for name in try fileSystem.contentsOfDirectory(root) where name.hasPrefix(prefix) {
            let path = PathUtilities.join(root, name)
            guard fileSystem.info(path)?.kind == .directory else { continue }
            generations.append(Generation(path: path, modified: fileSystem.modificationDate(path) ?? Date.distantPast))
        }
        generations.sort { lhs, rhs in
            if lhs.modified != rhs.modified { return lhs.modified > rhs.modified }
            return lhs.path > rhs.path
        }
        for old in generations.dropFirst(RuntimeConstants.previousDatabaseGenerationsKept) {
            try fileSystem.remove(old.path)
        }
    }

    /// `finalizeDatabaseSwitch`: clears the pending switch and remembers the previous
    /// generation; pruning older generations is cleanup that never fails the restore.
    public func finalizeDatabaseSwitch(_ token: DatabaseSwitchToken) async throws {
        try await writeState(
            set: [
                "previousDatabase": .string(token.previousDirectory),
                "lastDatabaseSwitchAt": .string(isoTimestamp(now())),
            ],
            remove: ["pendingDatabaseSwitch"])
        restoreSwitchOwnedThisLaunch = false
        startupRestoreRecovery = nil
        do {
            try prunePreviousDatabaseGenerations()
        } catch {
            fputs("[native] could not prune previous database generations: \(backupErrorMessage(error))\n", stderr)
        }
    }

    // MARK: - Attachments

    /// `exportAttachments`: a private copy of the attachments tree.
    public func exportAttachments(to destination: String) async throws {
        let source = layout.attachments
        try await runBlocking { try DirectorySwitch.export(source, to: destination) }
    }

    private func switchNonce() -> String {
        "\(nowMilliseconds())-\(ProcessInfo.processInfo.processIdentifier)"
    }

    /// `replaceAttachments(source, { preservePrevious: true })`: the switch token is
    /// persisted as `pendingAttachmentSwitch` before either rename (ADR-207), so a crash
    /// between the renames still leaves a journal. The blocking copy runs off the actor;
    /// the marker is written synchronously from `beforeSwitch` while this actor awaits it.
    public func replaceAttachments(from source: String) async throws -> DirectorySwitchToken {
        let destination = layout.attachments
        let nonce = switchNonce()
        let fileSystem = self.fileSystem
        let statePath = layout.state
        let runtimeId = names.id
        let clock = dependencies.clock
        return try await runBlocking {
            try DirectorySwitch.replace(
                source: source, destination: destination, preservePrevious: true, nonce: nonce,
                beforeSwitch: { token in
                    let data = try fileSystem.readIfPresent(statePath)
                    let current = try RuntimeMarker.parse(data)
                    if data != nil, current == nil {
                        throw NativeRuntimeError("INVALID_RUNTIME_STATE", "Invalid native runtime state")
                    }
                    let next = RuntimeMarker.merged(
                        current: current, runtimeId: runtimeId,
                        set: ["pendingAttachmentSwitch": try JSONValue(encoding: token)], remove: [], now: clock.now())
                    try fileSystem.writeFile(statePath, try JSONValue.object(next).serialized(), mode: 0o600)
                })
        }
    }

    /// `rollbackAttachmentSwitch`: the given token, else the persisted one.
    public func rollbackAttachmentSwitch(_ token: DirectorySwitchToken) async throws {
        try await rollbackPendingAttachmentSwitch(token)
    }

    public func rollbackPendingAttachmentSwitch(_ token: DirectorySwitchToken? = nil) async throws {
        var resolved = token
        if resolved == nil { resolved = try await persistedAttachmentSwitch() }
        let pending = resolved
        let nonce = switchNonce()
        _ = try await runBlocking { try DirectorySwitch.rollback(pending, nonce: nonce) }
        try await writeState(set: [:], remove: ["pendingAttachmentSwitch"])
    }

    /// `finalizeAttachmentSwitch`: removes the previous tree.
    public func finalizeAttachmentSwitch(_ token: DirectorySwitchToken) async throws {
        _ = try await runBlocking { try DirectorySwitch.finalize(token) }
        try await writeState(set: [:], remove: ["pendingAttachmentSwitch"])
    }

    /// The persisted `pendingAttachmentSwitch`, validated like `recoverInterruptedRestore`:
    /// it must target this runtime's attachments directory and keep its previous tree as a
    /// `<attachments>.previous-*` sibling. Malformed state throws instead of being renamed.
    public func persistedAttachmentSwitch() async throws -> DirectorySwitchToken? {
        guard let stored = try await readState()?["pendingAttachmentSwitch"], stored.isTruthy else { return nil }
        let invalid = NativeRuntimeError("INVALID_RESTORE_JOURNAL", "Invalid pending attachment restore journal")
        guard let token = try? stored.decode(DirectorySwitchToken.self),
            token.destinationDirectory == layout.attachments
        else { throw invalid }
        if let previous = token.previousDirectory {
            guard PathUtilities.dirname(previous) == PathUtilities.dirname(layout.attachments),
                PathUtilities.basename(previous).hasPrefix("\(PathUtilities.basename(layout.attachments)).previous-")
            else { throw invalid }
        }
        return token
    }

    /// What launch recovery did with an attachment switch a quit or crash interrupted.
    public enum AttachmentSwitchRecovery: Equatable, Sendable {
        /// The database switch was still pending, so the attachments were rolled back with it.
        case rolledBack
        /// The database switch had been finalized, so the restored attachments were kept.
        case finalized
    }

    /// The attachment half of `recoverInterruptedRestore` on its own; launch uses the
    /// coordinated recovery, which also rolls the database switch back.
    @discardableResult
    public func recoverPendingAttachmentSwitch() async throws -> AttachmentSwitchRecovery? {
        guard let token = try await persistedAttachmentSwitch() else { return nil }
        let state = try await readState() ?? [:]
        if let pending = state["pendingDatabaseSwitch"], pending.isTruthy {
            try await rollbackPendingAttachmentSwitch(token)
            return .rolledBack
        }
        try await finalizeAttachmentSwitch(token)
        return .finalized
    }

    /// `recoverInterruptedRestore` (ADR-207): resolves the attachment and database restore
    /// journals together before any write or Demo seed decision. While the database switch
    /// is pending the backend stops, the previous attachment tree comes back and the
    /// database switch rolls back; once the database switch was finalized the attachment
    /// journal is cleanup only. A database journal this version did not write is left alone;
    /// a malformed attachment journal or an ambiguous switch throws, so startup fails closed
    /// instead of creating a replacement database.
    public func recoverInterruptedRestore() async throws {
        let state = try await readState()
        let pending = state?["pendingDatabaseSwitch"].flatMap { $0.isTruthy ? $0 : nil }
        if let pending, !DatabaseSwitchToken.isSqliteToken(pending) { return }
        let attachments = try await persistedAttachmentSwitch()
        if let pending {
            try await stop()
            if let attachments { try await rollbackPendingAttachmentSwitch(attachments) }
            try await rollbackDatabaseSwitch(pending)
        } else if let attachments {
            // The database commit is durable; never roll its attachment generation back.
            try await finalizeAttachmentSwitch(attachments)
        }
    }

    /// `start()` without waiting for readiness, as a restore rollback restarts.
    public func startBackend() async throws {
        try await start()
    }

    /// `start()` then `waitUntilReady({ detailed: true })`, as a restore does after the switch.
    public func startBackendAndWait() async throws {
        try await start()
        try await waitUntilReady(detailed: true)
    }
}
