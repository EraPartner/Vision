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
    /// `HEALTH_POLL_BUILD_ATTEMPTS`: a cold start may initialize PostgreSQL, seed the
    /// Demo and run migrations, so the first navigation waits up to about 3 minutes.
    public var readinessAttempts: Int

    public init(
        environment: [String: String],
        homeDirectory: String,
        resourcesDirectory: String?,
        postgresPort: Int = VisionNativeIdentity.postgresPort,
        readinessAttempts: Int = 600
    ) {
        self.environment = environment
        self.homeDirectory = homeDirectory
        self.resourcesDirectory = resourcesDirectory
        self.postgresPort = postgresPort
        self.readinessAttempts = readinessAttempts
    }
}

/// Starts, supervises and stops Vision Native's runtime, following `launch()` and the
/// `will-quit` handler in `packaging/electron/main.ts`:
///
///     idle → locatingPayload → preparingDatabase → seedingDemo → startingBackend
///          → waitingForReadiness → running(url) → stopping → stopped
///
/// Any step can end in `failed(reason)`; `launch()` may then be called again (Retry).
public actor RuntimeSupervisor {
    private let configuration: SupervisorConfiguration
    private let dependencies: RuntimeDependencies
    private let instanceLock: any InstanceLocking
    private let logger: any RuntimeLogging
    public private(set) var phase: RuntimePhase = .idle
    private var runtime: NativeRuntime?
    private var launchTask: Task<URL, Error>?
    private var shutdownRequested = false

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
    public static func live(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: String = FileManager.default.homeDirectoryForCurrentUser.path,
        resourcesDirectory: String? = Bundle.main.resourcePath
    ) -> RuntimeSupervisor {
        let userData = VisionNativeIdentity.userDataDirectory(homeDirectory: homeDirectory)
        return RuntimeSupervisor(
            configuration: SupervisorConfiguration(
                environment: environment, homeDirectory: homeDirectory, resourcesDirectory: resourcesDirectory),
            dependencies: .live(),
            instanceLock: FileInstanceLock(),
            logger: FileRuntimeLog(path: PathUtilities.join(userData, "logs", "main.log"))
        )
    }

    private var fileSystem: any RuntimeFileSystem { dependencies.fileSystem }

    private func enter(_ next: RuntimePhase) {
        phase = next
        logger.log("log", "[runtime] phase \(next)")
    }

    /// Starts the runtime once and returns the frontend URL (`http://localhost:<port>`).
    /// Concurrent callers share one launch; after a failure the next call retries.
    public func launch() async throws -> URL {
        if case .running(let url) = phase { return url }
        if let launchTask { return try await launchTask.value }
        shutdownRequested = false
        let task = Task { try await self.performLaunch() }
        launchTask = task
        do {
            let url = try await task.value
            launchTask = nil
            enter(.running(url))
            return url
        } catch {
            launchTask = nil
            let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.log("error", "[runtime] launch failed: \(error)")
            enter(.failed(reason))
            throw error
        }
    }

    private func performLaunch() async throws -> URL {
        let layout = try RuntimeLayout(
            userDataDirectory: VisionNativeIdentity.userDataDirectory(homeDirectory: configuration.homeDirectory))
        try fileSystem.createDirectory(layout.userDataDirectory, mode: 0o700)
        guard try instanceLock.acquire(layout.instanceLock) else {
            throw NativeRuntimeError(
                "NATIVE_ALREADY_RUNNING",
                "Another Vision Native instance is already running. Quit it before opening this one.")
        }

        enter(.locatingPayload)
        let payload = try RuntimePayload.locate(
            environment: configuration.environment,
            resourcesDirectory: configuration.resourcesDirectory,
            fileSystem: fileSystem)
        logger.log("log", "[runtime] payload \(payload.runtimeDirectory) (\(payload.source))")
        let appPort = await resolveAppPort(layout)
        let runtime = try NativeRuntime(
            layout: layout,
            postgresPort: configuration.postgresPort,
            runtimeRoot: payload.runtimeDirectory,
            appPort: appPort,
            inheritedEnvironment: configuration.environment,
            dependencies: dependencies)
        self.runtime = runtime

        enter(.preparingDatabase)
        try await runtime.ensureLayout()
        enter(.seedingDemo)
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
            enter(.startingBackend)
            let started: BackendStartResult
            do {
                started = try await runtime.start()
            } catch let error as NativeRuntimeError where error.code == "PORT_COLLISION" {
                let repicked = await repickAppPort(layout)
                await runtime.setAppPort(repicked)
                started = try await runtime.start()
            }
            logger.log("log", "[runtime] backend \(started)")
            if prepared.switchToken != nil {
                try await runtime.waitUntilReady(detailed: true)
                if let warning = try await NativeDemo.finalize(
                    runtime: runtime, prepared: prepared, fileSystem: fileSystem, now: now)
                {
                    logger.log("warn", warning)
                }
            }
        } catch {
            if prepared.switchToken != nil {
                try await NativeDemo.rollback(runtime: runtime, prepared: prepared, now: now)
            }
            throw error
        }

        enter(.waitingForReadiness)
        let port = await runtime.currentAppPort
        guard let url = URL(string: "http://localhost:\(port)") else {
            throw NativeRuntimeError("BACKEND_URL_INVALID", "Invalid backend URL for port \(port)")
        }
        do {
            try await pollReady(url)
        } catch {
            let tail = await runtime.backendLogTail()
            logger.log("error", "[startup-diagnostics] native backend log\n\(tail)")
            throw error
        }
        return url
    }

    /// `pollReady`: `/health/detailed` until the dashboard data is ready; 20 fast probes
    /// at 100 ms, then every 300 ms.
    private func pollReady(_ baseURL: URL) async throws {
        let url = baseURL.appendingPathComponent("health/detailed", isDirectory: false)
        for attempt in 0..<configuration.readinessAttempts {
            if shutdownRequested {
                throw NativeRuntimeError("SHUTTING_DOWN", "Vision Native is quitting.")
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
            "The Vision backend did not become ready. Its log is in ~/Library/Application Support/Vision Native/native/\(VisionNativeIdentity.runtimeId)/logs/backend.log."
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

    // MARK: - Quit

    /// The `will-quit` path without backup-on-quit (phase 1d): stops the backend and
    /// PostgreSQL unless "keep services running on quit" is enabled. The caller bounds
    /// it with the 45-second hard timeout.
    public func shutdown() async {
        shutdownRequested = true
        if let launchTask { _ = try? await launchTask.value }
        guard let runtime else {
            enter(.stopped)
            return
        }
        enter(.stopping)
        if await keepServicesOnQuit(runtime) {
            logger.log("log", "[runtime] keepServicesOnQuit is on; leaving services running")
        } else {
            do {
                try await runtime.stop(keepPostgres: false)
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
