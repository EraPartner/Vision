import Foundation

/// The validated `demo-seed/manifest.json` (`DemoSeedManifest`, version 2).
public struct DemoSeedManifest: Sendable, Equatable {
    /// Hash of the generated seed SQL: identifies the Demo content across builds.
    public let logicalSha256: String
    /// Hash of the packaged database file.
    public let databaseSha256: String
    public let databaseBytes: Int
    /// Migration version the packaged database is at.
    public let schemaVersion: Int
    /// Rows per table in the packaged database, as the database tool counted them.
    public let tableCounts: [String: Int]
}

public struct DemoSeed: Sendable, Equatable {
    public let databasePath: String
    public let manifest: DemoSeedManifest
}

/// A database generation switch persisted before the live directory is renamed
/// (`pendingDatabaseSwitch` in the runtime marker, `DatabaseSwitchToken`).
public struct DatabaseSwitchToken: Codable, Sendable, Equatable {
    public static let currentVersion = 2
    public static let sqliteDirectoryKind = "sqlite-directory"

    public let version: Int
    public let kind: String
    public let liveDirectory: String
    public let previousDirectory: String
    public let activatedDirectory: String
    public let activatedAt: String

    public init(liveDirectory: String, previousDirectory: String, activatedDirectory: String, activatedAt: String) {
        version = Self.currentVersion
        kind = Self.sqliteDirectoryKind
        self.liveDirectory = liveDirectory
        self.previousDirectory = previousDirectory
        self.activatedDirectory = activatedDirectory
        self.activatedAt = activatedAt
    }

    /// `isSqliteSwitchToken`: a journal this version wrote.
    public static func isSqliteToken(_ value: JSONValue?) -> Bool {
        value?["version"] == .int(currentVersion) && value?["kind"] == .string(sqliteDirectoryKind)
    }
}

/// The result of `activateRestoredDatabase`.
public struct DatabaseActivation: Sendable, Equatable {
    public let switchToken: DatabaseSwitchToken
    public let validation: DatabaseFileReport
}

/// The runtime operations Demo seeding drives (`NativeDemoRuntime` in
/// `packaging/electron/runtime/native-demo.ts`).
public protocol DemoSeedingRuntime: Sendable {
    var layout: RuntimeLayout { get }
    func ensureLayout() async throws
    func discover() async throws
    func readState() async throws -> [String: JSONValue]?
    func writeState(set: [String: JSONValue], remove: [String]) async throws
    /// `recoverInterruptedRestore`: both restore journals, before any seed decision.
    func recoverInterruptedRestore() async throws
    func rollbackDatabaseSwitch(_ token: JSONValue?) async throws
    func activateRestoredDatabase(_ path: String, expectedSchemaVersion: Int?, expectedSha256: String?) async throws
        -> DatabaseActivation
    func verifyDatabaseFile(_ path: String) async throws -> DatabaseFileReport
    func finalizeDatabaseSwitch(_ token: DatabaseSwitchToken) async throws
    func stop() async throws
}

/// The result of `prepareNativeDemo`.
public struct PreparedNativeDemo: Sendable, Equatable {
    public enum Status: Sendable, Equatable {
        case current
        case activated
    }

    public let status: Status
    public let manifest: DemoSeedManifest
    public let previousDemoSeed: JSONValue?
    public let resetRequested: Bool
    public let switchToken: DatabaseSwitchToken?
}

/// Synthetic Demo data activation (ADR-114) for Vision Native's own data directory.
public enum NativeDemo {
    public static let resetRequestName = "demo-reset-request.json"
    /// `DEMO_SEED_DATABASE`: migrated to the build's head and loaded with the seed.
    public static let seedDatabaseName = "vision-demo.sqlite3"
    /// `DEMO_SEED_MANIFEST`.
    public static let seedManifestName = "manifest.json"

    private static func count(_ value: JSONValue?) -> Int? {
        guard let number = value?.intValue, number >= 0 else { return nil }
        return number
    }

    /// `validateDemoSeedManifest`.
    public static func validateManifest(_ value: JSONValue) throws -> DemoSeedManifest {
        guard value.objectValue != nil, value["version"] == .int(2), value["format"] == .string("sqlite"),
            let logical = value["logicalSha256"]?.stringValue, PathUtilities.isSHA256(logical),
            let database = value["databaseSha256"]?.stringValue, PathUtilities.isSHA256(database),
            let bytes = count(value["databaseBytes"]), bytes > 0,
            let schemaVersion = count(value["schemaVersion"]), schemaVersion > 0,
            let rawCounts = value["database"]?["tableCounts"]?.objectValue, !rawCounts.isEmpty
        else {
            throw NativeRuntimeError("DEMO_SEED_MANIFEST_INVALID", "Packaged Demo seed manifest is invalid")
        }
        var tableCounts: [String: Int] = [:]
        for (table, raw) in rawCounts {
            guard let rows = count(raw) else {
                throw NativeRuntimeError("DEMO_SEED_MANIFEST_INVALID", "Packaged Demo seed manifest is invalid")
            }
            tableCounts[table] = rows
        }
        return DemoSeedManifest(
            logicalSha256: logical, databaseSha256: database, databaseBytes: bytes, schemaVersion: schemaVersion,
            tableCounts: tableCounts)
    }

    /// `loadDemoSeed`: both files are regular (not symlinks) and the database matches its hash.
    public static func loadSeed(seedRoot: String, fileSystem: any RuntimeFileSystem) throws -> DemoSeed {
        let databasePath = PathUtilities.join(seedRoot, seedDatabaseName)
        let manifestPath = PathUtilities.join(seedRoot, seedManifestName)
        for candidate in [databasePath, manifestPath] {
            guard let info = fileSystem.info(candidate) else {
                throw NativeRuntimeError(
                    "DEMO_SEED_MISSING",
                    "The synthetic Demo seed is missing at \(seedRoot). Reinstall with ./install-native.sh.")
            }
            guard info.kind == .file else {
                throw NativeRuntimeError("DEMO_SEED_UNSAFE", "Packaged Demo seed contains an unsafe file")
            }
        }
        let manifest: DemoSeedManifest
        do {
            manifest = try validateManifest(try JSONValue.parse(try fileSystem.readFile(manifestPath)))
        } catch let error as NativeRuntimeError {
            throw error
        } catch {
            throw NativeRuntimeError("DEMO_SEED_MANIFEST_INVALID", "Packaged Demo seed manifest is invalid")
        }
        guard try fileSystem.sha256(databasePath).hex == manifest.databaseSha256 else {
            throw NativeRuntimeError("DEMO_SEED_CHECKSUM_MISMATCH", "Packaged Demo seed checksum does not match")
        }
        return DemoSeed(databasePath: databasePath, manifest: manifest)
    }

    /// `assertDemoRuntimeIsolation`: seeding only ever touches Vision Native's own runtime.
    /// The data directory and the runtime id must belong to the same variant.
    public static func assertIsolation(_ layout: RuntimeLayout) throws {
        guard NativeVariant.allCases.contains(where: { $0.runtimeId == layout.runtimeId }) else {
            throw NativeRuntimeError("DEMO_RUNTIME_UNSAFE", "Native Demo seeding requires the Vision Native runtime id")
        }
        guard let variant = NativeVariant.owning(userDataDirectory: layout.userDataDirectory),
            variant.runtimeId == layout.runtimeId,
            PathUtilities.dirname(layout.databaseDirectory) == layout.userDataDirectory
        else {
            throw NativeRuntimeError(
                "DEMO_RUNTIME_UNSAFE", "Native Demo seeding is restricted to the Vision Native data directory")
        }
    }

    /// `hasDemoResetRequest`: a regular `demo-reset-request.json` with `version: 1`,
    /// read through one `O_NOFOLLOW | O_NONBLOCK` descriptor.
    public static func hasResetRequest(_ layout: RuntimeLayout, fileSystem: any RuntimeFileSystem) throws -> Bool {
        try assertIsolation(layout)
        switch try fileSystem.readNoFollow(layout.demoResetRequest) {
        case .missing:
            return false
        case .unsafe:
            throw NativeRuntimeError("DEMO_RESET_UNSAFE", "Native Demo reset request is unsafe")
        case .contents(let data):
            guard let request = try? JSONValue.parse(data), request["version"] == .int(1) else {
                throw NativeRuntimeError("DEMO_RESET_INVALID", "Native Demo reset request is invalid")
            }
            return true
        }
    }

    /// `requestNativeDemoReset`: the canonical seed is restored on the next launch.
    public static func requestReset(_ layout: RuntimeLayout, fileSystem: any RuntimeFileSystem, now: Date) throws {
        try assertIsolation(layout)
        try fileSystem.createDirectory(layout.userDataDirectory, mode: 0o700)
        let request = JSONValue.object(["version": .int(1), "requestedAt": .string(isoTimestamp(now))])
        try fileSystem.writeFile(layout.demoResetRequest, try request.serialized(), mode: 0o600)
    }

    private static func seedMarker(_ manifest: DemoSeedManifest, _ timeKey: String, _ date: Date) -> JSONValue {
        .object([
            "logicalSha256": .string(manifest.logicalSha256),
            "databaseSha256": .string(manifest.databaseSha256),
            "schemaVersion": .int(manifest.schemaVersion),
            timeKey: .string(isoTimestamp(date)),
        ])
    }

    /// `prepareNativeDemo`: recovers an interrupted restore, skips a current seed, or
    /// activates the packaged database as the next generation (the runtime copies and
    /// verifies it and refuses it unless its checksum and schema version match the manifest)
    /// while keeping the previous generation for rollback.
    public static func prepare(
        runtime: any DemoSeedingRuntime,
        seedRoot: String,
        reset: Bool = false,
        fileSystem: any RuntimeFileSystem,
        now: @Sendable () -> Date
    ) async throws -> PreparedNativeDemo {
        let layout = runtime.layout
        try assertIsolation(layout)
        let seed = try loadSeed(seedRoot: seedRoot, fileSystem: fileSystem)
        let resetRequested = try reset || hasResetRequest(layout, fileSystem: fileSystem)
        try await runtime.ensureLayout()
        try await runtime.discover()
        // Recover both generations before deciding whether the seed is current (ADR-207).
        // Database-only rollback would leave new attachments against the old data.
        try await runtime.recoverInterruptedRestore()
        let state = try await runtime.readState() ?? [:]
        let currentSeed = state["demoSeed"]
        if !resetRequested,
            currentSeed?["logicalSha256"] == .string(seed.manifest.logicalSha256),
            currentSeed?["databaseSha256"] == .string(seed.manifest.databaseSha256),
            currentSeed?["schemaVersion"] == .int(seed.manifest.schemaVersion),
            fileSystem.exists(layout.database)
        {
            try await runtime.writeState(
                set: ["activeRuntime": .string("native"), "activation": .string("demo-native")],
                remove: ["demoSeedInProgress"])
            return PreparedNativeDemo(
                status: .current, manifest: seed.manifest, previousDemoSeed: nil, resetRequested: resetRequested,
                switchToken: nil)
        }
        try await runtime.writeState(
            set: [
                "activeRuntime": .string("native"),
                "activation": .string("demo-native"),
                "demoSeedInProgress": seedMarker(seed.manifest, "startedAt", now()),
            ],
            remove: [])
        let activation = try await runtime.activateRestoredDatabase(
            seed.databasePath, expectedSchemaVersion: seed.manifest.schemaVersion,
            expectedSha256: seed.manifest.databaseSha256)
        do {
            guard try fileSystem.sha256(layout.database).hex == seed.manifest.databaseSha256 else {
                throw NativeRuntimeError(
                    "DEMO_SEED_CHECKSUM_MISMATCH", "The activated Demo database does not match the packaged seed")
            }
        } catch {
            try await runtime.rollbackDatabaseSwitch(try JSONValue(encoding: activation.switchToken))
            throw error
        }
        return PreparedNativeDemo(
            status: .activated, manifest: seed.manifest, previousDemoSeed: state["demoSeed"],
            resetRequested: resetRequested, switchToken: activation.switchToken)
    }

    /// `finalizeNativeDemo`: after detailed readiness (the backend has started, and migrated
    /// when this build is newer than the seed), the database must not have moved backwards
    /// and its stable tables must still hold the seed's rows; then the switch is finalized and
    /// the applied seed recorded. Returns a warning when the reset request could not be removed.
    public static func finalize(
        runtime: any DemoSeedingRuntime,
        prepared: PreparedNativeDemo,
        fileSystem: any RuntimeFileSystem,
        now: @Sendable () -> Date
    ) async throws -> String? {
        if let token = prepared.switchToken {
            let afterStart = try await runtime.verifyDatabaseFile(runtime.layout.database)
            guard afterStart.schemaVersion >= prepared.manifest.schemaVersion else {
                throw NativeRuntimeError(
                    "DATABASE_SCHEMA_MISMATCH", "The Demo database schema moved backwards after startup")
            }
            if let counts = afterStart.tableCounts {
                try DatabaseStatistics.assertTableCountsEqual(
                    expected: prepared.manifest.tableCounts, actual: counts, tables: DatabaseStatistics.stableTables)
            }
            try await runtime.finalizeDatabaseSwitch(token)
        }
        try await runtime.writeState(
            set: [
                "activeRuntime": .string("native"),
                "activation": .string("demo-native"),
                "demoSeed": seedMarker(prepared.manifest, "appliedAt", now()),
            ],
            remove: ["demoSeedInProgress"])
        guard prepared.resetRequested else { return nil }
        do {
            try fileSystem.remove(runtime.layout.demoResetRequest)
            return nil
        } catch {
            return "The Demo database is ready, but its reset request could not be removed; the next launch may repeat the reset."
        }
    }

    /// `rollbackNativeDemo`: stops the backend, restores the previous generation and seed
    /// marker, and records the failure time.
    public static func rollback(
        runtime: any DemoSeedingRuntime,
        prepared: PreparedNativeDemo?,
        now: @Sendable () -> Date
    ) async throws {
        try? await runtime.stop()
        if let token = prepared?.switchToken {
            try await runtime.rollbackDatabaseSwitch(try JSONValue(encoding: token))
        }
        var set: [String: JSONValue] = [
            "activeRuntime": .string("native"),
            "activation": .string("demo-native"),
            "lastDemoSeedFailureAt": .string(isoTimestamp(now())),
        ]
        var remove = ["demoSeedInProgress"]
        if let previous = prepared?.previousDemoSeed {
            set["demoSeed"] = previous
        } else {
            remove.append("demoSeed")
        }
        try await runtime.writeState(set: set, remove: remove)
    }
}
