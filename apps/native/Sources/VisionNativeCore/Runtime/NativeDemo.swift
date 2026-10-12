import Foundation

/// The validated `demo-seed/manifest.json`.
public struct DemoSeedManifest: Sendable, Equatable {
    public let logicalSha256: String
    public let dumpSha256: String
    public let schemaRevision: String
    public let database: ComparableDatabaseStats
}

public struct DemoSeed: Sendable, Equatable {
    public let dumpPath: String
    public let manifest: DemoSeedManifest
}

/// A database switch persisted before the live database is renamed
/// (`pendingDatabaseSwitch` in the runtime marker).
public struct DatabaseSwitchToken: Codable, Sendable, Equatable {
    public let version: Int
    public let liveDatabase: String
    public let previousDatabase: String
    public let activatedDatabase: String
    public let activatedAt: String
}

/// The runtime operations Demo seeding drives (`NativeDemoRuntime` in
/// `packaging/electron/runtime/native-demo.ts`).
public protocol DemoSeedingRuntime: Sendable {
    var layout: RuntimeLayout { get }
    func ensureLayout() async throws
    func discover() async throws
    func readState() async throws -> [String: JSONValue]?
    func writeState(set: [String: JSONValue], remove: [String]) async throws
    func ensurePostgresReady() async throws
    func rollbackDatabaseSwitch(_ token: JSONValue?) async throws
    func validateCustomDump(_ path: String) async throws
    func activateRestoredDatabase(_ path: String, expectedSchemaHead: String) async throws -> DatabaseSwitchToken
    func getDatabaseStats() async throws -> DatabaseStats
    func finalizeDatabaseSwitch(_ token: DatabaseSwitchToken) async throws
    func stop(keepPostgres: Bool) async throws
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

    /// `validateDemoSeedManifest`.
    public static func validateManifest(_ value: JSONValue) throws -> DemoSeedManifest {
        let invalid = NativeRuntimeError("DEMO_SEED_MANIFEST_INVALID", "Packaged Demo seed manifest is invalid")
        guard value.objectValue != nil, value["version"] == .int(1),
            let logical = value["logicalSha256"]?.stringValue, PathUtilities.isSHA256(logical),
            let dump = value["dumpSha256"]?.stringValue, PathUtilities.isSHA256(dump),
            let schemaRevision = value["schemaRevision"]?.stringValue,
            !schemaRevision.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let database = value["database"], database.objectValue != nil,
            let tableCounts = database["tableCounts"]?.objectValue, !tableCounts.isEmpty
        else {
            throw invalid
        }
        guard database["schema"] == .string(schemaRevision) else {
            throw NativeRuntimeError(
                "DEMO_SEED_MANIFEST_INVALID", "Packaged Demo seed schema metadata is inconsistent")
        }
        return DemoSeedManifest(
            logicalSha256: logical,
            dumpSha256: dump,
            schemaRevision: schemaRevision,
            database: ComparableDatabaseStats(manifestDatabase: database)
        )
    }

    /// `loadDemoSeed`: both files are regular (not symlinks) and the dump matches its hash.
    public static func loadSeed(seedRoot: String, fileSystem: any RuntimeFileSystem) throws -> DemoSeed {
        let dumpPath = PathUtilities.join(seedRoot, "demo-seed.dump")
        let manifestPath = PathUtilities.join(seedRoot, "manifest.json")
        for candidate in [dumpPath, manifestPath] {
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
        guard try fileSystem.sha256(dumpPath).hex == manifest.dumpSha256 else {
            throw NativeRuntimeError("DEMO_SEED_CHECKSUM_MISMATCH", "Packaged Demo seed checksum does not match")
        }
        return DemoSeed(dumpPath: dumpPath, manifest: manifest)
    }

    /// `assertDemoRuntimeIsolation`: seeding only ever touches Vision Native's own runtime.
    /// The data directory and the runtime id must belong to the same variant.
    public static func assertIsolation(_ layout: RuntimeLayout) throws {
        guard NativeVariant.allCases.contains(where: { $0.runtimeId == layout.runtimeId }) else {
            throw NativeRuntimeError("DEMO_RUNTIME_UNSAFE", "Native Demo seeding requires the Vision Native runtime id")
        }
        guard let variant = NativeVariant.owning(userDataDirectory: layout.userDataDirectory),
            variant.runtimeId == layout.runtimeId
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

    /// `prepareNativeDemo`: rolls back an interrupted switch, skips a current seed, or
    /// restores the packaged dump into a staging database, verifies every table count
    /// and switches it in while keeping the previous database for rollback.
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
        var state = try await runtime.readState() ?? [:]
        if let pending = state["pendingDatabaseSwitch"], pending.isTruthy {
            try await runtime.ensurePostgresReady()
            try await runtime.rollbackDatabaseSwitch(pending)
            state = try await runtime.readState() ?? [:]
        }
        let currentSeed = state["demoSeed"]
        if !resetRequested,
            currentSeed?["logicalSha256"] == .string(seed.manifest.logicalSha256),
            currentSeed?["schemaRevision"] == .string(seed.manifest.schemaRevision)
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
                "demoSeedInProgress": .object([
                    "logicalSha256": .string(seed.manifest.logicalSha256),
                    "schemaRevision": .string(seed.manifest.schemaRevision),
                    "startedAt": .string(isoTimestamp(now())),
                ]),
            ],
            remove: [])
        try await runtime.validateCustomDump(seed.dumpPath)
        let token = try await runtime.activateRestoredDatabase(
            seed.dumpPath, expectedSchemaHead: seed.manifest.schemaRevision)
        let restored = try await runtime.getDatabaseStats()
        do {
            try DatabaseStatistics.assertEqual(expected: seed.manifest.database, actual: restored.comparable)
        } catch {
            try await runtime.rollbackDatabaseSwitch(try JSONValue(encoding: token))
            throw error
        }
        return PreparedNativeDemo(
            status: .activated, manifest: seed.manifest, previousDemoSeed: state["demoSeed"],
            resetRequested: resetRequested, switchToken: token)
    }

    /// `finalizeNativeDemo`: after detailed readiness, rechecks the stable counts, then
    /// finalizes the switch and records the applied seed. Returns a warning when the
    /// reset request could not be removed.
    public static func finalize(
        runtime: any DemoSeedingRuntime,
        prepared: PreparedNativeDemo,
        fileSystem: any RuntimeFileSystem,
        now: @Sendable () -> Date
    ) async throws -> String? {
        if let token = prepared.switchToken {
            let afterStart = try await runtime.getDatabaseStats()
            try DatabaseStatistics.assertStableEqual(expected: prepared.manifest.database, actual: afterStart.comparable)
            try await runtime.finalizeDatabaseSwitch(token)
        }
        try await runtime.writeState(
            set: [
                "activeRuntime": .string("native"),
                "activation": .string("demo-native"),
                "demoSeed": .object([
                    "logicalSha256": .string(prepared.manifest.logicalSha256),
                    "schemaRevision": .string(prepared.manifest.schemaRevision),
                    "appliedAt": .string(isoTimestamp(now())),
                ]),
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

    /// `rollbackNativeDemo`: stops the backend, restores the previous database and seed
    /// marker, and records the failure time.
    public static func rollback(
        runtime: any DemoSeedingRuntime,
        prepared: PreparedNativeDemo?,
        now: @Sendable () -> Date
    ) async throws {
        try? await runtime.stop(keepPostgres: true)
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
