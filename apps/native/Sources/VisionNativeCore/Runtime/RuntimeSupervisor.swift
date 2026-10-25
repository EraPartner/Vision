import Foundation

/// The supervisor's lifecycle, for logs and tests.
public enum RuntimePhase: Sendable, Equatable {
    case idle
    case locatingPayload
    case preparingDatabase
    case seedingDemo
    case startingBackend
    case waitingForReadiness
    case running(URL)
    case stopping
    case stopped
    case failed(String)
}

public struct SupervisorConfiguration: Sendable {
    /// The app's environment (`ProcessInfo.processInfo.environment`). Children only get
    /// the allowlisted keys.
    public var environment: [String: String]
    public var homeDirectory: String
    /// `Bundle.main.resourcePath`.
    public var resourcesDirectory: String?
    public var postgresPort: Int
    /// Vision Native or Vision Native Demo: the data directory and runtime id.
    public var variant: NativeVariant
    /// ADR-242: runs after PostgreSQL is ready and before the backend, which migrates at
    /// boot, is spawned, only when an existing database is behind the packaged migration
    /// chain (`backupBeforeMigrations` in `main.ts`). A thrown error fails the launch, so no
    /// migration runs without the backup it was meant to take. `nil` (the default, and for
    /// the synthetic Demo database) takes no backup.
    public var beforeMigrations: (@Sendable (PendingMigrations, NativeRuntime) async throws -> Void)?
    /// `HEALTH_POLL_BUILD_ATTEMPTS`: a cold start may initialize PostgreSQL, seed the
    /// Demo and run migrations, so the first navigation waits up to about 3 minutes.
    public var readinessAttempts: Int
    /// Whether `VISION_NATIVE_RUNTIME_DIR` is honoured (Debug builds only, like the
    /// backend URL override).
    public var allowPayloadOverride: Bool

    public init(
        environment: [String: String],
        homeDirectory: String,
        resourcesDirectory: String?,
        postgresPort: Int? = nil,
        readinessAttempts: Int = 600,
        allowPayloadOverride: Bool = false,
        variant: NativeVariant = .standard,
        beforeMigrations: (@Sendable (PendingMigrations, NativeRuntime) async throws -> Void)? = nil
    ) {
        self.environment = environment
        self.homeDirectory = homeDirectory
        self.resourcesDirectory = resourcesDirectory
        self.postgresPort = postgresPort ?? variant.postgresPort
        self.variant = variant
        self.beforeMigrations = beforeMigrations
        self.readinessAttempts = readinessAttempts
        self.allowPayloadOverride = allowPayloadOverride
    }
}

/// Starts, supervises and stops Vision Native's runtime, following `launch()` and the
/// `will-quit` handler in `packaging/electron/main.ts`:
///
///     idle → locatingPayload → preparingDatabase → seedingDemo → startingBackend
///          → waitingForReadiness → running(url) → stopping → stopped
///
/// Any step can end in `failed(reason)`; the backend it started is then stopped and
/// PostgreSQL keeps running, and `launch()` may be called again (Retry). A quit during a
/// launch does not wait for it: the launch is cancelled and stops at its next phase.
public actor RuntimeSupervisor: BackupSettingsStore {
    private let configuration: SupervisorConfiguration
    private let dependencies: RuntimeDependencies
    private let instanceLock: any InstanceLocking
    private let logger: any RuntimeLogging
    public private(set) var phase: RuntimePhase = .idle
    private var runtime: NativeRuntime?
    private var launchTask: Task<URL, Error>?
    private var shutdownRequested = false
    private var shutdownInProgress = false
    private var logRotated = false

    public init(
        configuration: SupervisorConfiguration,
        dependencies: RuntimeDependencies,
        instanceLock: any InstanceLocking,
        logger: any RuntimeLogging
    ) {
        self.configuration = configuration
        self.dependencies = dependencies
        self.instanceLock = instanceLock
        self.logger = logger
    }

    /// The live supervisor for the app.
    /// The live supervisor for the app. `main.log` is rotated only once the
    /// single-instance lock is held, so a second instance never renames it.
    public static func live(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: String = FileManager.default.homeDirectoryForCurrentUser.path,
        resourcesDirectory: String? = Bundle.main.resourcePath,
        allowPayloadOverride: Bool,
        variant: NativeVariant = .standard,
        beforeMigrations: (@Sendable (PendingMigrations, NativeRuntime) async throws -> Void)? = nil
    ) -> RuntimeSupervisor {
        let userData = variant.userDataDirectory(homeDirectory: homeDirectory)
        return RuntimeSupervisor(
            configuration: SupervisorConfiguration(
                environment: environment, homeDirectory: homeDirectory, resourcesDirectory: resourcesDirectory,
                allowPayloadOverride: allowPayloadOverride, variant: variant,
                beforeMigrations: beforeMigrations),
            dependencies: .live(),
            instanceLock: FileInstanceLock(),
            logger: FileRuntimeLog(path: PathUtilities.join(userData, "logs", "main.log"), rotate: false)
        )
    }

    private var fileSystem: any RuntimeFileSystem { dependencies.fileSystem }

    private func enter(_ next: RuntimePhase) {
        phase = next
        logger.log("log", "[runtime] phase \(next)")
    }

    private static let shuttingDownError = NativeRuntimeError("SHUTTING_DOWN", "Vision Native is quitting.")

    private func checkShutdown() throws {
        if shutdownRequested { throw Self.shuttingDownError }
    }

    /// Enters the next launch phase unless a quit has been requested meanwhile.
    private func enterLaunchPhase(_ next: RuntimePhase) throws {
        try checkShutdown()
        enter(next)
    }

    /// Starts the runtime once and returns the frontend URL (`http://localhost:<port>`).
    /// Concurrent callers share one launch; after a failure the next call retries.
    public func launch() async throws -> URL {
        if case .running(let url) = phase { return url }
        if let launchTask { return try await launchTask.value }
        guard !shutdownInProgress else { throw Self.shuttingDownError }
        shutdownRequested = false
        let task = Task { try await self.performLaunch() }
        launchTask = task
        do {
            let url = try await task.value
            launchTask = nil
            try checkShutdown()
            enter(.running(url))
            return url
        } catch {
            launchTask = nil
            // The quit owns the phase (`stopping`, then `stopped`) and the processes.
            if shutdownRequested { throw error }
            let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.log("error", "[runtime] launch failed: \(error)")
            enter(.failed(reason))
            throw error
        }
    }

    /// A failed launch stops the backend it started and keeps PostgreSQL running, so a
    /// Retry starts from a clean backend and a quit does not leave one behind.
    private func performLaunch() async throws -> URL {
        do {
            return try await launchSteps()
        } catch {
            if !shutdownRequested, let runtime {
                do {
                    try await runtime.stop(keepPostgres: true)
                } catch {
                    logger.log("warn", "[runtime] could not stop the backend after a failed launch: \(error)")
                }
            }
            throw error
        }
    }

    private func launchSteps() async throws -> URL {
        let layout = try RuntimeLayout(variant: configuration.variant, homeDirectory: configuration.homeDirectory)
        try fileSystem.createDirectory(layout.userDataDirectory, mode: 0o700)
        guard try instanceLock.acquire(layout.instanceLock) else {
            throw NativeRuntimeError(
                "NATIVE_ALREADY_RUNNING",
                "Another Vision Native instance is already running. Quit it before opening this one.")
        }
        if !logRotated {
            logRotated = true
            logger.rotate()
        }

        try enterLaunchPhase(.locatingPayload)
        if !configuration.allowPayloadOverride, configuration.environment[RuntimePayload.environmentKey] != nil {
            logger.log("warn", "[runtime] \(RuntimePayload.environmentKey) is ignored in Release builds.")
        }
        let payload = try RuntimePayload.locate(
            environment: configuration.environment,
            resourcesDirectory: configuration.resourcesDirectory,
            allowOverride: configuration.allowPayloadOverride,
            fileSystem: fileSystem)
        logger.log("log", "[runtime] payload \(payload.runtimeDirectory) (\(payload.source))")
        let appPort = await resolveAppPort(layout)
        try checkShutdown()
        let log = logger
        let runtime = try NativeRuntime(
            layout: layout,
            postgresPort: configuration.postgresPort,
            runtimeRoot: payload.runtimeDirectory,
            appPort: appPort,
            inheritedEnvironment: configuration.environment,
            dependencies: dependencies,
            recordBootPhase: { phase, milliseconds in log.log("log", "[runtime] \(phase) \(milliseconds) ms") })
        self.runtime = runtime

        try enterLaunchPhase(.preparingDatabase)
        try await runtime.ensureLayout()
        // A restore interrupted mid-switch is recovered by the Demo preparation, attachments
        // and database together, before any write or seed decision. A malformed journal or
        // an ambiguous switch fails the launch closed (ADR-207).
        try enterLaunchPhase(.seedingDemo)
        let clock = dependencies.clock
        let now: @Sendable () -> Date = { clock.now() }
        let prepared = try await NativeDemo.prepare(
            runtime: runtime, seedRoot: payload.demoSeedDirectory, fileSystem: fileSystem, now: now)
        if prepared.status == .current,
            let warning = try await NativeDemo.finalize(
                runtime: runtime, prepared: prepared, fileSystem: fileSystem, now: now)
        {
            logger.log("warn", warning)
        }
        do {
            try enterLaunchPhase(.startingBackend)
            let started: BackendStartResult
            var beforeMigrations: (@Sendable (PendingMigrations) async throws -> Void)?
            if let hook = configuration.beforeMigrations {
                beforeMigrations = { pending in try await hook(pending, runtime) }
            }
            do {
                started = try await runtime.start(beforeMigrations: beforeMigrations)
            } catch let error as NativeRuntimeError where error.code == "PORT_COLLISION" {
                let repicked = await repickAppPort(layout)
                await runtime.setAppPort(repicked)
                started = try await runtime.start(beforeMigrations: beforeMigrations)
            }
            logger.log("log", "[runtime] backend \(started)")
            if prepared.switchToken != nil {
                try await runtime.waitUntilReady(detailed: true)
                try checkShutdown()
                if let warning = try await NativeDemo.finalize(
                    runtime: runtime, prepared: prepared, fileSystem: fileSystem, now: now)
                {
                    logger.log("warn", warning)
                }
            }
        } catch {
            // During a quit the persisted switch plan is rolled back on the next launch.
            if prepared.switchToken != nil, !shutdownRequested {
                try await NativeDemo.rollback(runtime: runtime, prepared: prepared, now: now)
            }
            throw error
        }

        try enterLaunchPhase(.waitingForReadiness)
        let port = await runtime.currentAppPort
        guard let url = URL(string: "http://localhost:\(port)") else {
            throw NativeRuntimeError("BACKEND_URL_INVALID", "Invalid backend URL for port \(port)")
        }
        do {
            try await pollReady(url)
        } catch {
            if !shutdownRequested {
                let tail = await runtime.backendLogTail()
                logger.log("error", "[startup-diagnostics] native backend log\n\(tail)")
            }
            throw error
        }
        return url
    }

    /// `pollReady`: `/health/detailed` until the dashboard data is ready; 20 fast probes
    /// at 100 ms, then every 300 ms.
    private func pollReady(_ baseURL: URL) async throws {
        let url = baseURL.appendingPathComponent("health/detailed", isDirectory: false)
        for attempt in 0..<configuration.readinessAttempts {
            try checkShutdown()
            // The backend exited during startup: show why instead of polling until the timeout.
            if let runtime, let failure = await runtime.backendStartupFailure() {
                throw NativeRuntimeError("BACKEND_EXITED", failure)
            }
            if let response = try? await dependencies.http.get(url, timeout: 2),
                HealthReadiness.navigationReadiness(status: response.status, body: response.body) == true
            {
                return
            }
            await dependencies.clock.sleep(milliseconds: attempt + 1 < 20 ? 100 : 300)
        }
        throw NativeRuntimeError(
            "BACKEND_NOT_READY",
            "The Vision backend did not become ready. Its log is in ~/Library/Application Support/\(configuration.variant.userDataName)/native/\(configuration.variant.runtimeId)/logs/backend.log."
        )
    }

    // MARK: - settings.json

    /// `loadSettings`: a corrupt file is renamed to `settings.json.corrupt-<ms>`.
    private func loadSettings(_ layout: RuntimeLayout) -> [String: JSONValue] {
        guard let data = try? fileSystem.readIfPresent(layout.settings) else { return [:] }
        guard let parsed = try? JSONValue.parse(data) else {
            let corrupt = "\(layout.settings).corrupt-\(epochMilliseconds(dependencies.clock.now()))"
            try? fileSystem.move(layout.settings, corrupt)
            logger.log("warn", "[settings] Corrupt settings.json renamed to \(corrupt)")
            return [:]
        }
        return parsed.objectValue ?? [:]
    }

    private func persistAppPort(_ port: Int, _ layout: RuntimeLayout) {
        var settings = loadSettings(layout)
        settings["appPort"] = .int(port)
        do {
            try fileSystem.writeFile(layout.settings, try JSONValue.object(settings).serialized(), mode: 0o600)
        } catch {
            logger.log("warn", "[port] failed to persist appPort: \(error)")
        }
    }

    /// `resolveAppPort`: the persisted random port, else a new one, persisted.
    private func resolveAppPort(_ layout: RuntimeLayout) async -> Int {
        if let persisted = AppSettings.persistedAppPort(loadSettings(layout)) { return persisted }
        let port = await AppSettings.pickRandomFreePort(ports: dependencies.ports, random: dependencies.random)
        persistAppPort(port, layout)
        return port
    }

    /// `repickAppPort`: self-heals when another process holds the persisted port.
    private func repickAppPort(_ layout: RuntimeLayout) async -> Int {
        let port = await AppSettings.pickRandomFreePort(ports: dependencies.ports, random: dependencies.random)
        persistAppPort(port, layout)
        logger.log("warn", "[port] backend port collision; re-picked \(port)")
        return port
    }

    // MARK: - Shell settings

    private func settingsLayout() throws -> RuntimeLayout {
        try RuntimeLayout(variant: configuration.variant, homeDirectory: configuration.homeDirectory)
    }

    /// `settings.json` for the shell (window frame, language, splash theme, services mirror).
    public func currentSettings() -> [String: JSONValue] {
        guard let layout = try? settingsLayout() else { return [:] }
        return loadSettings(layout)
    }

    /// `updateSettings`: a read-modify-write that runs on this actor, so it never interleaves
    /// with the runtime's own `appPort` writes.
    public func updateSettings(_ update: @Sendable (inout [String: JSONValue]) -> Void) throws {
        let layout = try settingsLayout()
        try fileSystem.createDirectory(layout.userDataDirectory, mode: 0o700)
        var settings = loadSettings(layout)
        update(&settings)
        try fileSystem.writeFile(layout.settings, try JSONValue.object(settings).serialized(), mode: 0o600)
    }

    /// `RuntimeLayout.rawState`: the native-only mode's raw-state store (ADR-211).
    public nonisolated var rawStatePath: String {
        PathUtilities.join(
            configuration.variant.userDataDirectory(homeDirectory: configuration.homeDirectory), "native",
            configuration.variant.runtimeId, "raw-state.json")
    }

    /// The runtime's log folder (`activeRuntime.paths.logs`), which `recovery:open-logs` opens.
    public nonisolated var logsDirectory: String {
        PathUtilities.join(
            configuration.variant.userDataDirectory(homeDirectory: configuration.homeDirectory), "native",
            configuration.variant.runtimeId, "logs")
    }

    /// `settings.json`, read synchronously before the window exists (`readSavedWindowBounds`).
    /// Unlike `currentSettings()` it never renames a corrupt file.
    public nonisolated var settingsPath: String {
        PathUtilities.join(configuration.variant.userDataDirectory(homeDirectory: configuration.homeDirectory), "settings.json")
    }

    // MARK: - Backup

    /// The runtime backup and restore use (`activeRuntime` of mode "native"): only once the
    /// launch has finished and while no quit is in progress.
    public func backupRuntime() -> NativeRuntime? {
        guard case .running = phase, !shutdownRequested else { return nil }
        return runtime
    }

    /// The variant this supervisor runs.
    public nonisolated var variant: NativeVariant { configuration.variant }

    // MARK: - Quit

    /// The `will-quit` service shutdown; the quit-time backup runs before it
    /// (`ShellController.prepareForQuit`). It stops the backend and
    /// PostgreSQL unless "keep services running on quit" is enabled. Like Electron it
    /// does not wait for a launch in progress: the launch is cancelled (which ends its
    /// running tool), the runtime refuses to spawn anything further, and a Demo staging
    /// database without a persisted switch plan is dropped. The caller bounds it with the
    /// 45-second hard timeout.
    public func shutdown() async {
        shutdownRequested = true
        shutdownInProgress = true
        defer { shutdownInProgress = false }
        launchTask?.cancel()
        guard let runtime else {
            enter(.stopped)
            return
        }
        enter(.stopping)
        await runtime.beginShutdown()
        if await keepServicesOnQuit(runtime) {
            logger.log("log", "[runtime] keepServicesOnQuit is on; leaving services running")
            await runtime.discardStagingRestore()
        } else {
            do {
                try await runtime.stopBackend()
                await runtime.discardStagingRestore()
                try await runtime.stopPostgres()
            } catch {
                logger.log("error", "runtime shutdown failed: \(error)")
            }
        }
        enter(.stopped)
    }

    /// `resolveKeepServicesOnQuit`: the database setting, else the `settings.json` mirror.
    private func keepServicesOnQuit(_ runtime: NativeRuntime) async -> Bool {
        let port = await runtime.currentAppPort
        if let url = URL(string: "http://localhost:\(port)/api/settings/services_settings"),
            let response = try? await dependencies.http.get(url, timeout: 2),
            (200..<300).contains(response.status),
            let body = try? JSONValue.parse(response.body),
            let keep = AppSettings.keepServicesFromSettingsResponse(body)
        {
            return keep
        }
        return AppSettings.keepServicesFromSettings(loadSettings(runtime.layout))
    }
}
