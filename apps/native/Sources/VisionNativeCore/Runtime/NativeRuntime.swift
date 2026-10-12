import Darwin
import Foundation

/// How a backend start ended (`StartResult`).
public enum BackendStartResult: Sendable, Equatable {
    case alreadyRunning(pid: Int32, port: Int)
    case started(pid: Int32, port: Int, database: String)
}

/// `ManagedClusterResult` for the managed (packaged) cluster.
public struct ManagedClusterResult: Sendable, Equatable {
    public enum Status: Sendable, Equatable {
        case existing
        case initialized
    }

    public let status: Status
    public let configChanged: Bool
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

/// Supervises Vision Native's private PostgreSQL 18 cluster and the packaged Bun
/// backend. A port of the lifecycle half of `createNativeRuntime` in
/// `packaging/electron/runtime/native.ts`: layout, generated credentials, payload
/// discovery, `initdb`, role and extension bootstrap, PostgreSQL start and stop, the
/// backend child, PID ownership, health, and the database switch used by Demo seeding.
/// Backup, attachment switching and the audit bridge are later phases.
public actor NativeRuntime: DemoSeedingRuntime {
    public nonisolated let layout: RuntimeLayout
    public nonisolated let names: RuntimeNames
    public nonisolated let postgresPort: Int
    /// The verified payload root (`VISION_RUNTIME_ROOT` for the backend).
    public nonisolated let runtimeRoot: String

    private let inheritedEnvironment: [String: String]
    private let dependencies: RuntimeDependencies
    private var appPort: Int
    private var tools: NativeTools?
    private var postgresChild: SpawnedChild?
    private var backendChild: SpawnedChild?
    public private(set) var newClusterCreatedThisLaunch = false
    private var shuttingDown = false
    /// The staging database of a Demo restore whose switch plan is not persisted yet.
    private var stagingRestoreDatabase: String?

    public init(
        layout: RuntimeLayout,
        postgresPort: Int = VisionNativeIdentity.postgresPort,
        runtimeRoot: String,
        appPort: Int,
        inheritedEnvironment: [String: String],
        dependencies: RuntimeDependencies
    ) throws {
        self.layout = layout
        names = try RuntimeNames(runtimeId: layout.runtimeId)
        self.postgresPort = try validateNetworkPort(postgresPort, "native PostgreSQL port")
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

    private func tool(_ name: String) throws -> String {
        try requireTools().tool(name)
    }

    private func ensureDiscovered() async throws {
        if tools == nil { try await discover() }
    }

    public var currentAppPort: Int { appPort }

    /// From now on refuses to spawn PostgreSQL or the backend and to begin a database
    /// switch, so a launch that is still running cannot start anything behind a quit.
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

    /// `ensureLayout`: private directories, then `runtime.env` (created once, upgraded
    /// with a cluster administrator when older), validated and pinned to the port.
    @discardableResult
    public func prepareLayout() throws -> DatabaseConfig {
        for directory in [layout.nativeRoot, layout.logs, layout.attachments, layout.cache, layout.postgresRoot] {
            try fileSystem.createDirectory(directory, mode: 0o700)
        }
        let text: String
        switch try readRuntimeEnv() {
        case .some(let existing):
            let upgraded = RuntimeEnvFile.ensureAdmin(existing, names: names, random: dependencies.random)
            _ = try RuntimeEnvFile.databaseConfig(upgraded)
            if upgraded != existing {
                try fileSystem.writeText(layout.env, upgraded, mode: 0o600)
            } else {
                try fileSystem.setMode(layout.env, 0o600)
            }
            text = upgraded
        case .none:
            text = RuntimeEnvFile.render(names: names, postgresPort: postgresPort, random: dependencies.random)
            try fileSystem.writeText(layout.env, text, mode: 0o600)
        }
        let config = try RuntimeEnvFile.databaseConfig(text)
        guard config.port == postgresPort else {
            throw NativeRuntimeError(
                "POSTGRES_PORT_MISMATCH", "Native runtime configuration targets a different PostgreSQL port.")
        }
        return config
    }

    public func ensureLayout() async throws {
        try prepareLayout()
    }

    /// `runtime.env` holds every database secret, so it is read without following a
    /// symlink and must be a regular file; `nil` when it does not exist yet.
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

    /// `discover`: verifies the payload manifest and finds every tool.
    @discardableResult
    public func discoverTools() async throws -> NativeTools {
        let discovered = try await RuntimePayload.discoverTools(
            runtimeRoot: runtimeRoot,
            environment: inheritedEnvironment,
            fileSystem: fileSystem,
            runner: dependencies.runner,
            childEnvironment: safeEnvironment())
        tools = discovered
        return discovered
    }

    public func discover() async throws {
        try await discoverTools()
    }

    // MARK: - PostgreSQL cluster

    /// `ensureManagedPostgresConfig`: writes `vision.conf` and includes it from
    /// `postgresql.conf`. Returns whether anything changed (a restart is then needed).
    @discardableResult
    public func ensureManagedPostgresConfig(_ dataDirectory: String) throws -> Bool {
        let visionConf = PathUtilities.join(dataDirectory, "vision.conf")
        let desired = PostgresSQL.visionConf(port: postgresPort)
        let current = try fileSystem.readIfPresent(visionConf).map { String(decoding: $0, as: UTF8.self) }
        var changed = current != desired
        if changed { try fileSystem.writeText(visionConf, desired, mode: 0o600) }
        let postgresqlConf = PathUtilities.join(dataDirectory, "postgresql.conf")
        let base = try fileSystem.readText(postgresqlConf)
        if !PostgresSQL.includesVisionConf(base) {
            let terminated = base.hasSuffix("\n") ? base : base + "\n"
            try fileSystem.writeText(postgresqlConf, terminated + PostgresSQL.includeLine + "\n", mode: 0o600)
            changed = true
        }
        return changed
    }

    /// `ensureManagedPostgresCluster`: opens the existing major-18 cluster, or quarantines
    /// an interrupted one and initializes a new cluster in a staging directory that is
    /// renamed into place only after `initdb` and the configuration succeed.
    public func ensureManagedPostgresCluster(_ config: DatabaseConfig) async throws -> ManagedClusterResult {
        let versionPath = PathUtilities.join(layout.postgresData, "PG_VERSION")
        if let versionData = try fileSystem.readIfPresent(versionPath) {
            let version = String(decoding: versionData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard version == String(RuntimeConstants.postgresMajor) else {
                throw NativeRuntimeError(
                    "POSTGRES_DATA_WRONG_VERSION",
                    "Vision's private PostgreSQL cluster must be major \(RuntimeConstants.postgresMajor).")
            }
            try fileSystem.setMode(layout.postgresData, 0o700)
            let changed = try ensureManagedPostgresConfig(layout.postgresData)
            return ManagedClusterResult(status: .existing, configChanged: changed)
        }
        if let existing = fileSystem.info(layout.postgresData) {
            guard existing.kind != .symlink else {
                throw NativeRuntimeError("POSTGRES_DATA_UNSAFE", "Vision PostgreSQL data directory is a symlink")
            }
            try fileSystem.move(
                layout.postgresData, PathUtilities.join(layout.postgresRoot, "data.incomplete-\(nowMilliseconds())"))
        }
        let processID = ProcessInfo.processInfo.processIdentifier
        let staging = PathUtilities.join(layout.postgresRoot, "data.initializing-\(processID)-\(nowMilliseconds())")
        let secretDirectory = try fileSystem.makeTemporaryDirectory(prefix: "vision-initdb-")
        do {
            let passwordFile = PathUtilities.join(secretDirectory, "password")
            try fileSystem.writeText(passwordFile, "\(config.adminPassword)\n", mode: 0o600)
            _ = try await run(
                try tool("initdb"),
                PostgresSQL.initdbArguments(
                    dataDirectory: staging, adminRole: config.adminRole, passwordFile: passwordFile),
                timeout: 5 * 60,
                environment: ChildEnvironment.managedPostgres(inherited: inheritedEnvironment))
            try ensureManagedPostgresConfig(staging)
            try fileSystem.setMode(staging, 0o700)
            try fileSystem.move(staging, layout.postgresData)
            newClusterCreatedThisLaunch = true
            try? fileSystem.remove(secretDirectory)
            return ManagedClusterResult(status: .initialized, configChanged: true)
        } catch {
            if fileSystem.exists(staging) {
                try? fileSystem.move(
                    staging, PathUtilities.join(layout.postgresRoot, "data.failed-\(nowMilliseconds())"))
            }
            try? fileSystem.remove(secretDirectory)
            throw error
        }
    }

    /// `withPgPass`: runs one command with a temporary 0600 password file for one role,
    /// removed afterwards.
    private func runWithPgPass(
        _ config: DatabaseConfig,
        role: String,
        password: String,
        _ executable: String,
        _ arguments: [String],
        timeout: TimeInterval
    ) async throws -> RunResult {
        let directory = try fileSystem.makeTemporaryDirectory(prefix: "vision-pgpass-")
        do {
            let pgpass = PathUtilities.join(directory, "pgpass")
            try fileSystem.writeText(pgpass, "\(host):\(config.port):*:\(role):\(password)\n", mode: 0o600)
            let result = try await run(
                executable, arguments, timeout: timeout, environment: safeEnvironment([("PGPASSFILE", pgpass)]))
            try? fileSystem.remove(directory)
            return result
        } catch {
            try? fileSystem.remove(directory)
            throw error
        }
    }

    private func runAsClusterAdmin(
        _ config: DatabaseConfig,
        _ executable: String,
        _ arguments: [String],
        timeout: TimeInterval
    ) async throws -> RunResult {
        try await runWithPgPass(
            config, role: config.adminRole, password: config.adminPassword, executable, arguments, timeout: timeout)
    }

    private func runAsOwner(
        _ config: DatabaseConfig,
        _ executable: String,
        _ arguments: [String],
        timeout: TimeInterval
    ) async throws -> RunResult {
        try await runWithPgPass(
            config, role: config.ownerRole, password: config.ownerPassword, executable, arguments, timeout: timeout)
    }

    /// `inspectReadyPostgres`: the server on our port must be major 18, loopback-only
    /// and serve exactly our data directory.
    private func inspectReadyPostgres(_ config: DatabaseConfig) async throws {
        let psql = try tool("psql")
        let result = try await runAsClusterAdmin(
            config, psql,
            [
                "-h", host, "-p", String(postgresPort), "-U", config.adminRole, "--dbname", "postgres",
                "--tuples-only", "--no-align", "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--command",
                PostgresSQL.inspectServerQuery,
            ],
            timeout: 10)
        let lines = result.stdout.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard let versionNum = lines.first.flatMap({ Int($0) }),
            versionNum / 10_000 == RuntimeConstants.postgresMajor
        else {
            throw NativeRuntimeError(
                "POSTGRES_WRONG_VERSION", "Native PostgreSQL server must be major \(RuntimeConstants.postgresMajor).")
        }
        let addresses = (lines.count > 1 ? lines[1] : "").split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard PostgresSQL.isLoopbackOnly(addresses) else {
            throw NativeRuntimeError(
                "POSTGRES_UNSAFE_BIND", "PostgreSQL listen_addresses is not loopback-only; refusing to start Vision.")
        }
        let actual = lines.count > 2 ? fileSystem.realPath(lines[2]) : nil
        guard let expected = fileSystem.realPath(layout.postgresData), actual == expected else {
            throw NativeRuntimeError(
                "POSTGRES_PORT_COLLISION", "The native PostgreSQL port belongs to a different database cluster.")
        }
    }

    private func postgresIsReady(timeout: TimeInterval) async -> Bool {
        guard let pgIsReady = try? tool("pg_isready") else { return false }
        let arguments = ["-h", host, "-p", String(postgresPort), "-d", "postgres"]
        return (try? await run(pgIsReady, arguments, timeout: timeout)) != nil
    }

    /// `startManagedPostgres`: refuses an occupied port, then runs `postgres` directly
    /// with its output appended to `postgres.log` and records its PID.
    private func startManagedPostgres() async throws {
        guard await dependencies.ports.isPortFree(postgresPort) else {
            throw NativeRuntimeError(
                "POSTGRES_PORT_COLLISION", "Native PostgreSQL port \(postgresPort) is already in use.")
        }
        let recordPath = layout.postgresPid
        let spawnedPID = LockedValue<Int32>(0)
        try ensureNotShuttingDown()
        let child = try dependencies.spawner.spawn(
            try tool("postgres"),
            PostgresSQL.serverArguments(dataDirectory: layout.postgresData, port: postgresPort),
            cwd: layout.postgresRoot,
            environment: ChildEnvironment.managedPostgres(inherited: inheritedEnvironment),
            logPath: layout.postgresLog,
            onExit: { [self] in
                let pid = spawnedPID.withLock { $0 }
                Task { await self.clearPIDRecord(recordPath, pid: pid) }
            })
        guard child.pid > 1 else {
            throw NativeRuntimeError("POSTGRES_UNAVAILABLE", "Native PostgreSQL did not provide a process id")
        }
        spawnedPID.withLock { $0 = child.pid }
        postgresChild = child
        try fileSystem.writeFile(
            recordPath,
            try PIDRecord.postgres(
                pid: child.pid, port: postgresPort, runtimeId: names.id, dataDirectory: layout.postgresData, now: now()
            ).serialized(),
            mode: 0o600)
    }

    /// Removes a PID record only when it still names the exited process.
    private func clearPIDRecord(_ path: String, pid: Int32) {
        guard pid > 1, PIDRecord.recordedPID(try? fileSystem.readIfPresent(path)) == pid else { return }
        try? fileSystem.remove(path)
    }

    /// `ensurePostgresReady`: reuses a running cluster that passes inspection (restarting
    /// it after a configuration change), otherwise starts it and waits up to 60 probes.
    public func ensurePostgresReady(startService: Bool) async throws {
        try await ensureDiscovered()
        let config = try prepareLayout()
        let cluster = try await ensureManagedPostgresCluster(config)
        var ready = await postgresIsReady(timeout: 5)
        if ready {
            do {
                try await inspectReadyPostgres(config)
            } catch let error as NativeRuntimeError where error.code == "POSTGRES_WRONG_VERSION" {
                throw error
            } catch {
                throw NativeRuntimeError(
                    "POSTGRES_PORT_COLLISION", "Native PostgreSQL port \(postgresPort) is occupied by another server.")
            }
            if !cluster.configChanged { return }
            guard startService else {
                throw NativeRuntimeError(
                    "POSTGRES_RESTART_REQUIRED", "Managed PostgreSQL configuration changed and requires a restart.")
            }
            try await stopPostgres()
            ready = false
        }
        if !ready && startService {
            try await startManagedPostgres()
            for _ in 0..<60 {
                if postgresChild?.hasExited() == true { break }
                ready = await postgresIsReady(timeout: 3)
                if ready { break }
                await dependencies.clock.sleep(milliseconds: 500)
            }
        }
        guard ready else {
            throw NativeRuntimeError("POSTGRES_UNAVAILABLE", "PostgreSQL 18 did not become ready on 127.0.0.1.")
        }
        try await inspectReadyPostgres(config)
    }

    public func ensurePostgresReady() async throws {
        try await ensurePostgresReady(startService: true)
    }

    /// `runSecretAdminSql`: SQL containing secrets goes through a 0600 file, never argv,
    /// and a failure never echoes the statement.
    private func runSecretAdminSQL(_ config: DatabaseConfig, _ sql: String) async throws {
        let directory = try fileSystem.makeTemporaryDirectory(prefix: "vision-pg-admin-")
        do {
            let sqlFile = PathUtilities.join(directory, "command.sql")
            try fileSystem.writeText(sqlFile, "\(sql)\n", mode: 0o600)
            do {
                _ = try await runAsClusterAdmin(
                    config, try tool("psql"),
                    [
                        "-h", host, "-p", String(postgresPort), "-U", config.adminRole, "--dbname", "postgres",
                        "--set", "ON_ERROR_STOP=1", "--no-psqlrc", "--file", sqlFile,
                    ],
                    timeout: 10)
            } catch {
                throw NativeRuntimeError("POSTGRES_ROLE_BOOTSTRAP_FAILED", "Native database role bootstrap failed")
            }
            try? fileSystem.remove(directory)
        } catch {
            try? fileSystem.remove(directory)
            throw error
        }
    }

    private func adminArguments(_ config: DatabaseConfig) -> [String] {
        [
            "-h", host, "-p", String(postgresPort), "-U", config.adminRole, "--dbname", "postgres", "--set",
            "ON_ERROR_STOP=1", "--no-psqlrc",
        ]
    }

    private func roleExists(_ role: String, _ config: DatabaseConfig) async throws -> Bool {
        let result = try await runAsClusterAdmin(
            config, try tool("psql"),
            adminArguments(config) + ["--tuples-only", "--no-align", "--command", PostgresSQL.roleExistsQuery(role)],
            timeout: 10)
        return result.stdout.trimmingCharacters(in: .whitespacesAndNewlines) == "1"
    }

    /// `bootstrapDatabase`: owner and application roles (created once, passwords and
    /// attributes reset every launch), the read-only analysis executor, the database
    /// owned by the migration owner, and the required extensions.
    @discardableResult
    public func bootstrapDatabase() async throws -> DatabaseConfig {
        let config = try prepareLayout()
        try await ensurePostgresReady(startService: true)
        let psql = try tool("psql")
        let adminArgs = adminArguments(config)

        if !(try await roleExists(config.ownerRole, config)) {
            try await runSecretAdminSQL(
                config, try PostgresSQL.createLoginRole(config.ownerRole, password: config.ownerPassword))
        }
        try await runSecretAdminSQL(
            config, try PostgresSQL.alterLoginRole(config.ownerRole, password: config.ownerPassword))
        if !(try await roleExists(config.appRole, config)) {
            try await runSecretAdminSQL(
                config, try PostgresSQL.createLoginRole(config.appRole, password: config.appPassword))
        }
        try await runSecretAdminSQL(
            config, try PostgresSQL.alterLoginRole(config.appRole, password: config.appPassword))

        if !(try await roleExists(RuntimeConstants.analysisRole, config)) {
            try await runSecretAdminSQL(config, PostgresSQL.createAnalysisRole)
        }
        try await runSecretAdminSQL(config, PostgresSQL.configureAnalysisRole(password: config.analysisPassword))

        let databaseExists = try await runAsClusterAdmin(
            config, psql,
            adminArgs + [
                "--tuples-only", "--no-align", "--command", PostgresSQL.databaseExistsQuery(config.database),
            ],
            timeout: 10)
        if databaseExists.stdout.trimmingCharacters(in: .whitespacesAndNewlines) != "1" {
            _ = try await runAsClusterAdmin(
                config, try tool("createdb"),
                [
                    "-h", host, "-p", String(postgresPort), "-U", config.adminRole, "--template", "template0",
                    "--owner", config.ownerRole, config.database,
                ],
                timeout: 30)
        }
        _ = try await runAsClusterAdmin(
            config, psql,
            adminArgs + [
                "--command", try PostgresSQL.alterDatabaseOwner(config.database, owner: config.ownerRole),
            ],
            timeout: 10)
        try await installRequiredExtensions(config.database, config)
        return config
    }

    /// `installRequiredExtensions`: `pg_stat_statements` is untrusted, so the private
    /// cluster administrator installs all three; the owner stays a non-superuser.
    private func installRequiredExtensions(_ database: String, _ config: DatabaseConfig) async throws {
        let target = try validateIdentifier(database, "database name")
        _ = try await runAsClusterAdmin(
            config, try tool("psql"),
            [
                "-h", host, "-p", String(config.port), "-U", config.adminRole, "-d", target, "--set",
                "ON_ERROR_STOP=1", "--no-psqlrc", "--command", PostgresSQL.createExtensions,
            ],
            timeout: 30)
    }

    // MARK: - Runtime marker

    public func readState() async throws -> [String: JSONValue]? {
        try RuntimeMarker.parse(try fileSystem.readIfPresent(layout.state))
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

    /// `start`: bootstraps the database, reuses a healthy backend this runtime started
    /// earlier, refuses to touch a PID owned by another program, then spawns the
    /// compiled backend on the loopback app port with the allowlisted environment.
    /// Unlike Electron (`BACKEND_STALE_PID`), a recorded backend of ours that does not
    /// answer `/health` is stopped and replaced, so Retry can recover from it.
    public func start() async throws -> BackendStartResult {
        try await assertNativeActive()
        let config = try await bootstrapDatabase()
        let tools = try requireTools()
        _ = try RuntimePayload.requireChrome(tools.chrome)
        if let existing = PIDRecord.recordedPID(try? fileSystem.readIfPresent(layout.pid)),
            dependencies.processes.exists(existing)
        {
            guard await processMatchesBackend(existing) else {
                throw NativeRuntimeError(
                    "BACKEND_PID_OWNERSHIP_MISMATCH",
                    "The recorded backend process id belongs to another process; refusing to signal it.")
            }
            if (try? await waitUntilReady(attempts: 3, intervalMilliseconds: 500)) != nil {
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
            runtimeRoot: runtimeRoot,
            alembic: tools.alembic,
            chrome: tools.chrome)
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
        return .started(pid: child.pid, port: port, database: config.database)
    }

    /// `stopBackend`: SIGTERM, up to `forceAfterMilliseconds` of grace, then SIGKILL, only
    /// for a recorded PID whose command line is our backend.
    public func stopBackend(forceAfterMilliseconds: Int = 10_000) async throws {
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
        }
        try? fileSystem.remove(layout.pid)
    }

    /// `stopPostgres`: `pg_ctl stop -m fast` on exactly our data directory.
    public func stopPostgres() async throws {
        guard fileSystem.exists(PathUtilities.join(layout.postgresData, "PG_VERSION")) else {
            try? fileSystem.remove(layout.postgresPid)
            return
        }
        try await ensureDiscovered()
        let postmasterPid = PathUtilities.join(layout.postgresData, "postmaster.pid")
        guard fileSystem.exists(postmasterPid) else {
            try? fileSystem.remove(layout.postgresPid)
            return
        }
        do {
            _ = try await run(
                try tool("pg_ctl"), ["-D", layout.postgresData, "-m", "fast", "-w", "-t", "30", "stop"], timeout: 35)
        } catch {
            if fileSystem.exists(postmasterPid) { throw error }
        }
        try? fileSystem.remove(layout.postgresPid)
    }

    /// `stop`: the backend, then PostgreSQL unless `keepPostgres`.
    public func stop(keepPostgres: Bool) async throws {
        try await stopBackend()
        if !keepPostgres { try await stopPostgres() }
    }

    /// The last lines of `backend.log`, redacted, for the app log after a failed start.
    public func backendLogTail(lines: Int = 200) -> String {
        guard let data = try? fileSystem.readIfPresent(layout.backendLog) else { return "" }
        let text = String(decoding: data, as: UTF8.self)
        return redactDiagnostics(text.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines)
            .joined(separator: "\n"))
    }

    // MARK: - Database switch (Demo seeding)

    private func adminDatabasePsql(_ database: String, _ command: String, timeout: TimeInterval = 30) async throws
        -> RunResult
    {
        try await ensureDiscovered()
        let config = try prepareLayout()
        let target = try validateIdentifier(database, "database name")
        return try await runAsClusterAdmin(
            config, try tool("psql"),
            [
                "-h", host, "-p", String(postgresPort), "-U", config.adminRole, "--dbname", target, "--set",
                "ON_ERROR_STOP=1", "--no-psqlrc", "--command", command,
            ],
            timeout: timeout)
    }

    private func adminPsql(_ command: String) async throws {
        _ = try await adminDatabasePsql("postgres", command)
    }

    private func terminateDatabaseConnections(_ database: String) async throws {
        let name = try validateIdentifier(database, "database name")
        try await adminPsql(PostgresSQL.terminateConnections(name))
    }

    public func databaseExists(_ database: String) async throws -> Bool {
        let name = try validateIdentifier(database, "database name")
        let result = try await adminDatabasePsql("postgres", PostgresSQL.databaseExistsQuery(name))
        return result.stdout.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.contains("1")
    }

    /// `restoreDatabaseName`: `<base[0..40]>_<suffix>_<10 hex>`.
    private func temporaryDatabaseName(_ base: String, _ suffix: String) throws -> String {
        try validateIdentifier(
            "\(base.prefix(40))_\(suffix)_\(dependencies.random.hex(byteCount: 5))", "temporary database name")
    }

    private func createEmptyDatabase(_ database: String, owner: String) async throws {
        let config = try prepareLayout()
        let name = try validateIdentifier(database, "database name")
        let ownerRole = try validateIdentifier(owner, "owner role")
        _ = try await runAsClusterAdmin(
            config, try tool("createdb"),
            [
                "-h", host, "-p", String(postgresPort), "-U", config.adminRole, "--template", "template0", "--owner",
                ownerRole, name,
            ],
            timeout: 30)
    }

    /// `restoreIntoDatabase` for a custom-format dump: extensions as the administrator,
    /// objects as the restricted owner in one transaction, then the two runtime-managed
    /// materialized views handed to the application role.
    private func restoreIntoDatabase(_ source: String, _ database: String, _ config: DatabaseConfig) async throws {
        guard let info = fileSystem.info(source), info.kind == .file, info.size > 0 else {
            throw NativeRuntimeError(
                "INVALID_POSTGRES_DUMP", "PostgreSQL restore source is empty or not a file")
        }
        let target = try validateIdentifier(database, "database name")
        try await installRequiredExtensions(target, config)
        let pgRestore = try tool("pg_restore")
        _ = try await runAsOwner(
            config, pgRestore,
            [
                "--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "--no-comments", "-h", host,
                "-p", String(config.port), "-U", config.ownerRole, "-d", target, source,
            ],
            timeout: 30 * 60)
        _ = try await adminDatabasePsql(target, try PostgresSQL.materializedViewOwnership(appRole: config.appRole))
    }

    /// `validateRestoredDatabase`: public tables exist and the Alembic heads match.
    private func validateRestoredDatabase(_ database: String, _ config: DatabaseConfig, expectedSchemaHead: String)
        async throws
    {
        let target = try validateIdentifier(database, "database name")
        let psql = try tool("psql")
        let result = try await runAsOwner(
            config, psql,
            [
                "-h", host, "-p", String(config.port), "-U", config.ownerRole, "-d", target, "--tuples-only",
                "--no-align", "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--command",
                PostgresSQL.restoredDatabaseQuery,
            ],
            timeout: 30)
        let lines = result.stdout.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard let last = lines.last, let tableCount = Int(last), tableCount > 0 else {
            throw NativeRuntimeError("RESTORE_VALIDATION_FAILED", "Restored database has no public schema tables")
        }
        let restoredHeads = lines.dropLast().sorted()
        let expectedHeads = expectedSchemaHead.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.sorted()
        guard !expectedHeads.isEmpty else { return }
        let matches =
            expectedHeads.count > 1
            ? restoredHeads == expectedHeads : restoredHeads.contains(expectedHeads[0])
        guard matches else {
            throw NativeRuntimeError(
                "RESTORE_VALIDATION_FAILED", "Restored database schema revision does not match backup metadata")
        }
    }

    /// `validateCustomDump`: a non-empty regular file that `pg_restore --list` accepts.
    public func validateCustomDump(_ path: String) async throws {
        guard let info = fileSystem.info(path), info.kind == .file, info.size > 0 else {
            throw NativeRuntimeError("INVALID_POSTGRES_DUMP", "PostgreSQL custom dump is empty or not a file")
        }
        try await ensureDiscovered()
        do {
            _ = try await run(try tool("pg_restore"), ["--list", path], timeout: 60)
        } catch {
            throw NativeRuntimeError("INVALID_POSTGRES_DUMP", "PostgreSQL custom dump is corrupt or truncated")
        }
    }

    /// `activateRestoredDatabase`: restores into a staging database, validates it, persists
    /// the rename plan, stops the backend and swaps names, keeping the previous database.
    public func activateRestoredDatabase(_ path: String, expectedSchemaHead: String) async throws
        -> DatabaseSwitchToken
    {
        try await assertNativeActive()
        let config = try await bootstrapDatabase()
        let staging = try temporaryDatabaseName(config.database, "restore")
        let previous = try temporaryDatabaseName(config.database, "previous")
        var token: DatabaseSwitchToken?
        stagingRestoreDatabase = staging
        do {
            try await createEmptyDatabase(staging, owner: config.ownerRole)
        } catch {
            stagingRestoreDatabase = nil
            throw error
        }
        do {
            try await restoreIntoDatabase(path, staging, config)
            try await validateRestoredDatabase(staging, config, expectedSchemaHead: expectedSchemaHead)
            try ensureNotShuttingDown()
            let plan = DatabaseSwitchToken(
                version: 1, liveDatabase: config.database, previousDatabase: previous, activatedDatabase: staging,
                activatedAt: isoTimestamp(now()))
            token = plan
            // From here the persisted plan owns the staging database (rollback handles it).
            stagingRestoreDatabase = nil
            try await writeState(set: ["pendingDatabaseSwitch": try JSONValue(encoding: plan)], remove: [])
            try await stop(keepPostgres: true)
            try await terminateDatabaseConnections(config.database)
            try await terminateDatabaseConnections(staging)
            try await adminPsql(try PostgresSQL.renameDatabase(config.database, to: previous))
            try await adminPsql(try PostgresSQL.renameDatabase(staging, to: config.database))
            return plan
        } catch {
            if let token {
                do {
                    try await rollbackDatabaseSwitch(try JSONValue(encoding: token))
                } catch {
                    throw NativeRuntimeError(
                        "DATABASE_SWITCH_RECOVERY_FAILED",
                        "Native database activation failed and automatic rollback did not complete; Vision remains stopped."
                    )
                }
            } else {
                stagingRestoreDatabase = nil
                if (try? await databaseExists(staging)) == true {
                    try? await terminateDatabaseConnections(staging)
                    try? await adminPsql(try PostgresSQL.dropDatabase(staging))
                }
            }
            throw error
        }
    }

    /// Drops the staging database of a Demo restore that a quit interrupted before its
    /// switch plan was persisted. A persisted plan is rolled back on the next launch.
    public func discardStagingRestore() async {
        guard let staging = stagingRestoreDatabase else { return }
        stagingRestoreDatabase = nil
        guard (try? await databaseExists(staging)) == true else { return }
        try? await terminateDatabaseConnections(staging)
        try? await adminPsql(try PostgresSQL.dropDatabase(staging))
    }

    /// `rollbackDatabaseSwitch`: restores the previous database for every interruption
    /// point and preserves the failed copy for inspection.
    public func rollbackDatabaseSwitch(_ token: JSONValue?) async throws {
        let config = try prepareLayout()
        var candidate = token
        if candidate == nil || candidate?.isTruthy == false {
            candidate = try await readState()?["pendingDatabaseSwitch"]
        }
        guard let switchToken = candidate, switchToken["liveDatabase"] == .string(config.database) else {
            throw NativeRuntimeError("NO_DATABASE_SWITCH", "No matching native database switch is available")
        }
        let previous = try validateIdentifier(switchToken["previousDatabase"]?.stringValue, "previous database name")
        let activated = try validateIdentifier(
            switchToken["activatedDatabase"]?.stringValue, "activated database name")
        try await stop(keepPostgres: true)
        let liveExists = try await databaseExists(config.database)
        let previousExists = try await databaseExists(previous)
        let activatedExists = try await databaseExists(activated)
        let state = DatabaseSwitchState.classify(liveExists: liveExists, previousExists: previousExists)
        if state == .unsafe {
            throw NativeRuntimeError(
                "DATABASE_SWITCH_UNSAFE",
                "Neither the live nor previous native database exists; automatic rollback is unsafe")
        }
        if liveExists { try await terminateDatabaseConnections(config.database) }
        if previousExists { try await terminateDatabaseConnections(previous) }
        if activatedExists { try await terminateDatabaseConnections(activated) }

        var preservedFailed: String? = activatedExists ? activated : nil
        if state == .activated {
            let failed = try temporaryDatabaseName(config.database, "failed")
            try await adminPsql(try PostgresSQL.renameDatabase(config.database, to: failed))
            do {
                try await adminPsql(try PostgresSQL.renameDatabase(previous, to: config.database))
            } catch {
                try? await adminPsql(try PostgresSQL.renameDatabase(failed, to: config.database))
                throw error
            }
            preservedFailed = failed
        } else if state == .betweenRenames {
            try await adminPsql(try PostgresSQL.renameDatabase(previous, to: config.database))
        }
        var rollback: [String: JSONValue] = [
            "restoredDatabase": .string(state == .beforeRenames ? config.database : previous),
            "rolledBackAt": .string(isoTimestamp(now())),
        ]
        if let preservedFailed { rollback["preservedFailedDatabase"] = .string(preservedFailed) }
        try await writeState(set: ["lastRollback": .object(rollback)], remove: ["pendingDatabaseSwitch"])
    }

    /// `finalizeDatabaseSwitch`: clears the pending switch and remembers the previous name.
    public func finalizeDatabaseSwitch(_ token: DatabaseSwitchToken) async throws {
        try await writeState(
            set: [
                "previousDatabase": .string(token.previousDatabase),
                "lastDatabaseSwitchAt": .string(isoTimestamp(now())),
            ],
            remove: ["pendingDatabaseSwitch"])
    }

    /// `getDatabaseStats` as the migration owner.
    public func getDatabaseStats() async throws -> DatabaseStats {
        let config = try prepareLayout()
        try await ensureDiscovered()
        let psql = try tool("psql")
        let result = try await runAsOwner(
            config, psql,
            [
                "-h", host, "-p", String(config.port), "-U", config.ownerRole, "-d", config.database,
                "--tuples-only", "--no-align", "--field-separator", "\t", "--quiet", "--no-psqlrc", "--set",
                "ON_ERROR_STOP=1", "--command", DatabaseStatistics.sql,
            ],
            timeout: 60)
        return try DatabaseStatistics.parse(result.stdout)
    }
}
