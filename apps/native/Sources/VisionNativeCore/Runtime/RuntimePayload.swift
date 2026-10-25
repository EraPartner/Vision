import CryptoKit
import Foundation

/// Where the runtime payload (PostgreSQL, the compiled backend, the Apple Foundation Models
/// helper, the frontend build and the migrations) and the synthetic Demo seed were found.
public struct RuntimePayloadLocation: Sendable, Equatable {
    public enum Source: Sendable, Equatable {
        case environment
        case appBundle
    }

    /// The prepared `native-runtime` tree (`manifest.json`, `postgres/`, `vision-backend`, `db/`, …).
    public let runtimeDirectory: String
    /// `demo-seed/` beside it (`demo-seed.dump` and `manifest.json`).
    public let demoSeedDirectory: String
    public let source: Source
}

/// The tools found in a verified payload (`NativeTools`).
public struct NativeTools: Sendable, Equatable {
    public let binDirectory: String
    public let versions: [String: String]
    public let versionNumbers: [String: Int]
    public let compiledBackend: String

    public func tool(_ name: String) -> String {
        PathUtilities.join(binDirectory, name)
    }
}

/// How a launch verified the payload (`LaunchManifestVerification`): a full hash of every
/// file or the recorded size check.
public enum RuntimeVerificationMode: String, Sendable, Equatable {
    case full
    case cached
}

/// Payload discovery and verification, ported from `verifyRuntimeManifest`,
/// `verifyRuntimeManifestOnLaunch`, `bundledPostgresBin` and `discoverPostgres18` in
/// `packaging/electron/runtime/native.ts` and `runtime-manifest.ts`.
///
/// The payload (`packaging/electron/scripts/prepare-native-runtime.ts`) holds
/// `vision-backend`, `vision-apple-ai`, `dist/`, `db/` (the Kysely migrations the backend
/// applies at boot), `config/postgres/app-role-grants.sql.tpl`, `postgres/` and `licenses/`.
/// It has no Alembic runtime and no Chrome Headless Shell: reports print through the
/// shell, and the backend locates `vision-apple-ai` itself from `VISION_RUNTIME_ROOT`.
public enum RuntimePayload {
    /// Development override: an absolute path to a prepared `native-runtime` directory.
    /// Honoured in Debug builds only.
    public static let environmentKey = "VISION_NATIVE_RUNTIME_DIR"
    /// `Contents/Resources/runtime` in the app bundle (install-native.sh stages it).
    public static let bundleDirectoryName = "runtime"
    public static let demoSeedDirectoryName = "demo-seed"

    public static let missingPayloadMessage =
        "This Vision Native build has no runtime payload (PostgreSQL 18, the backend and its migrations). "
        + "Install with ./install-native.sh, which stages the payload into the app, or, in a Debug build, set "
        + "\(environmentKey) to a prepared native-runtime directory "
        + "(cd packaging/electron && bun run prepare:native)."

    /// `VISION_NATIVE_RUNTIME_DIR` when set and `allowOverride` (Debug builds), else
    /// `<resources>/runtime`, so a Release build only ever runs its own signed payload.
    /// The Demo seed is the `demo-seed` sibling of the runtime directory in both cases.
    public static func locate(
        environment: [String: String],
        resourcesDirectory: String?,
        allowOverride: Bool,
        fileSystem: any RuntimeFileSystem
    ) throws -> RuntimePayloadLocation {
        if allowOverride, let raw = environment[environmentKey], !raw.isEmpty {
            guard raw.hasPrefix("/") else {
                throw NativeRuntimeError(
                    "NATIVE_RUNTIME_DIR_INVALID", "\(environmentKey) must be an absolute path; got \(raw).")
            }
            let runtimeDirectory = PathUtilities.normalize(raw)
            guard fileSystem.info(PathUtilities.join(runtimeDirectory, "manifest.json"))?.kind == .file else {
                throw NativeRuntimeError(
                    "NATIVE_RUNTIME_MISSING",
                    "\(environmentKey) points to \(runtimeDirectory), which has no manifest.json. Prepare it with "
                        + "cd packaging/electron && bun run prepare:native.")
            }
            return location(runtimeDirectory, source: .environment)
        }
        guard let resourcesDirectory else {
            throw NativeRuntimeError("NATIVE_RUNTIME_MISSING", missingPayloadMessage)
        }
        let runtimeDirectory = PathUtilities.join(resourcesDirectory, bundleDirectoryName)
        guard fileSystem.info(PathUtilities.join(runtimeDirectory, "manifest.json"))?.kind == .file else {
            throw NativeRuntimeError("NATIVE_RUNTIME_MISSING", missingPayloadMessage)
        }
        return location(runtimeDirectory, source: .appBundle)
    }

    private static func location(_ runtimeDirectory: String, source: RuntimePayloadLocation.Source)
        -> RuntimePayloadLocation
    {
        RuntimePayloadLocation(
            runtimeDirectory: runtimeDirectory,
            demoSeedDirectory: PathUtilities.join(PathUtilities.dirname(runtimeDirectory), demoSeedDirectoryName),
            source: source
        )
    }

    private static func corrupt(_ message: String) -> NativeRuntimeError {
        NativeRuntimeError("NATIVE_RUNTIME_CORRUPT", message)
    }

    // MARK: - Manifest

    struct ManifestEntry: Equatable {
        let path: String
        let bytes: Int
        let sha256: String
    }

    struct ParsedManifest: Equatable {
        let appVersion: String?
        let entries: [ManifestEntry]
    }

    /// `parseManifest`: version 1, and every entry a safe relative path with a non-negative
    /// size and a SHA-256, listed once.
    static func parseManifest(_ data: Data) throws -> ParsedManifest {
        let manifest: JSONValue
        do {
            manifest = try JSONValue.parse(data)
        } catch {
            throw corrupt("Native runtime manifest is missing or invalid")
        }
        guard manifest["version"] == .int(1), let rawEntries = manifest["entries"]?.arrayValue else {
            throw corrupt("Native runtime manifest has an unsupported format")
        }
        var seen = Set<String>()
        var entries: [ManifestEntry] = []
        for entry in rawEntries {
            guard let relative = entry["path"]?.stringValue,
                PathUtilities.fullMatch(relative, "[A-Za-z0-9._@+/-]+"),
                !relative.hasPrefix("/"),
                !relative.split(separator: "/", omittingEmptySubsequences: false).contains(".."),
                let bytes = entry["bytes"]?.intValue,
                bytes >= 0,
                let digest = entry["sha256"]?.stringValue,
                PathUtilities.isSHA256(digest),
                !seen.contains(relative)
            else {
                throw corrupt("Native runtime manifest contains an invalid entry")
            }
            seen.insert(relative)
            entries.append(ManifestEntry(path: relative, bytes: bytes, sha256: digest))
        }
        return ParsedManifest(appVersion: manifest["appVersion"]?.stringValue, entries: entries)
    }

    private static func readManifestBytes(_ runtimeRoot: String, fileSystem: any RuntimeFileSystem) throws -> Data {
        do {
            return try fileSystem.readFile(PathUtilities.join(runtimeRoot, "manifest.json"))
        } catch {
            throw corrupt("Native runtime manifest is missing or invalid")
        }
    }

    /// `listPayloadFiles`: every payload file except `manifest.json`; a symlink or special
    /// file throws.
    private static func listPayloadFiles(_ runtimeRoot: String, fileSystem: any RuntimeFileSystem) throws
        -> Set<String>
    {
        var files = Set<String>()
        func visit(_ directory: String, _ prefix: String) throws {
            for name in try fileSystem.contentsOfDirectory(directory) {
                let absolute = PathUtilities.join(directory, name)
                let relative = prefix.isEmpty ? name : "\(prefix)/\(name)"
                switch fileSystem.info(absolute)?.kind {
                case .directory?:
                    try visit(absolute, relative)
                case .file?:
                    if relative != "manifest.json" { files.insert(relative) }
                default:
                    throw corrupt("Native runtime payload contains an unsupported entry: \(relative)")
                }
            }
        }
        try visit(runtimeRoot, "")
        return files
    }

    /// `verifyRuntimeManifest(root, { required: true })`: every file is listed with its
    /// size and SHA-256, no entry escapes the root, and nothing unlisted, symlinked or
    /// special exists. Returns the number of entries.
    @discardableResult
    public static func verifyManifest(runtimeRoot: String, fileSystem: any RuntimeFileSystem) throws -> Int {
        let manifest = try parseManifest(try readManifestBytes(runtimeRoot, fileSystem: fileSystem))
        return try verifyFull(manifest, runtimeRoot: runtimeRoot, fileSystem: fileSystem)
    }

    private static func verifyFull(_ manifest: ParsedManifest, runtimeRoot: String, fileSystem: any RuntimeFileSystem)
        throws -> Int
    {
        for entry in manifest.entries {
            let actual: (bytes: Int, hex: String)
            do {
                actual = try fileSystem.sha256(PathUtilities.join(runtimeRoot, entry.path))
            } catch {
                throw corrupt("Native runtime payload is missing \(entry.path)")
            }
            guard entry.bytes == actual.bytes, actual.hex == entry.sha256 else {
                throw corrupt("Native runtime payload failed checksum verification: \(entry.path)")
            }
        }
        let actualPaths = try listPayloadFiles(runtimeRoot, fileSystem: fileSystem)
        guard actualPaths == Set(manifest.entries.map(\.path)) else {
            throw corrupt("Native runtime payload contains files not covered by its manifest")
        }
        return manifest.entries.count
    }

    /// `payloadMatchesSizes`, the cheap launch check: exactly the listed regular files,
    /// each with its recorded size. Any failure answers false so the caller re-hashes.
    private static func payloadMatchesSizes(
        _ manifest: ParsedManifest, runtimeRoot: String, fileSystem: any RuntimeFileSystem
    ) -> Bool {
        guard let actual = try? listPayloadFiles(runtimeRoot, fileSystem: fileSystem),
            actual == Set(manifest.entries.map(\.path))
        else {
            return false
        }
        return manifest.entries.allSatisfy { entry in
            let info = fileSystem.info(PathUtilities.join(runtimeRoot, entry.path))
            return info?.kind == .file && info?.size == entry.bytes
        }
    }

    /// The marker that records a completed full verification (`VerificationMarker`). It lives
    /// in the application data directory, never inside the signed application bundle.
    private static let markerVersion = 1

    private static func markerMatches(
        _ data: Data?, manifestSha256: String, runtimeRoot: String, appVersion: String?
    ) -> Bool {
        guard let data, let marker = try? JSONValue.parse(data),
            marker["version"] == .int(markerVersion),
            marker["manifestSha256"] == .string(manifestSha256),
            marker["runtimeRoot"] == .string(runtimeRoot)
        else {
            return false
        }
        // A marker's `appVersion` is null or a string, never absent.
        switch marker["appVersion"] {
        case .null?: return appVersion == nil
        case .string(let recorded)?: return appVersion == recorded
        default: return false
        }
    }

    /// `verifyRuntimeManifestOnLaunch` (ADR-235). The first launch of an installed payload
    /// hashes every file and then records the manifest's SHA-256 (which covers the app
    /// version and every file's size and hash) in `markerPath`. Later launches with the same
    /// manifest and payload location only check that exactly the listed regular files exist
    /// with their recorded sizes. Any mismatch, or a missing or different marker, falls
    /// back to the full hash check. Failing to write the marker never blocks startup.
    public static func verifyManifestOnLaunch(
        runtimeRoot: String, markerPath: String, fileSystem: any RuntimeFileSystem
    ) throws -> (entries: Int, mode: RuntimeVerificationMode) {
        let root = PathUtilities.normalize(runtimeRoot)
        let manifestBytes = try readManifestBytes(root, fileSystem: fileSystem)
        let manifestSha256 = SHA256.hash(data: manifestBytes).map { String(format: "%02x", $0) }.joined()
        let manifest = try parseManifest(manifestBytes)

        let markerData = try? fileSystem.readIfPresent(markerPath)
        if markerMatches(markerData, manifestSha256: manifestSha256, runtimeRoot: root, appVersion: manifest.appVersion),
            payloadMatchesSizes(manifest, runtimeRoot: root, fileSystem: fileSystem)
        {
            return (manifest.entries.count, .cached)
        }

        let entries = try verifyFull(manifest, runtimeRoot: root, fileSystem: fileSystem)
        let marker = JSONValue.object([
            "version": .int(markerVersion),
            "appVersion": manifest.appVersion.map { JSONValue.string($0) } ?? .null,
            "manifestSha256": .string(manifestSha256),
            "runtimeRoot": .string(root),
            "entries": .int(entries),
            "verifiedAt": .string(isoTimestamp(Date())),
        ])
        if let data = try? marker.serialized() {
            try? fileSystem.writeFile(markerPath, data, mode: 0o600)
        }
        return (entries, .full)
    }

    // MARK: - PostgreSQL

    /// Safe relative path in payload metadata: not absolute and without `..`.
    private static func isSafeRelative(_ value: String) -> Bool {
        !value.hasPrefix("/")
            && !value.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" })
                .contains("..")
    }

    /// `bundledPostgresBin`: `postgres/runtime.json` must pin PostgreSQL 18.6 for this
    /// platform and architecture. `nil` when the payload has no PostgreSQL metadata.
    public static func postgresBinDirectory(runtimeRoot: String, fileSystem: any RuntimeFileSystem) throws
        -> String?
    {
        let postgresRoot = PathUtilities.join(runtimeRoot, "postgres")
        guard let data = try fileSystem.readIfPresent(PathUtilities.join(postgresRoot, "runtime.json")) else {
            return nil
        }
        guard let metadata = try? JSONValue.parse(data) else {
            throw NativeRuntimeError("POSTGRES_RUNTIME_CORRUPT", "Packaged PostgreSQL metadata is invalid")
        }
        guard metadata.objectValue != nil,
            metadata["version"] == .int(1),
            metadata["postgresMajor"] == .int(RuntimeConstants.postgresMajor),
            metadata["postgresVersion"] == .string(RuntimeConstants.postgresVersion),
            metadata["platform"] == .string(RuntimeConstants.payloadPlatform),
            metadata["architecture"] == .string(RuntimeConstants.payloadArchitecture),
            let binRelative = metadata["binRelative"]?.stringValue,
            isSafeRelative(binRelative)
        else {
            throw NativeRuntimeError(
                "POSTGRES_RUNTIME_MISMATCH", "Packaged PostgreSQL metadata does not match this Vision build")
        }
        let root = PathUtilities.join(postgresRoot, "root")
        let binDirectory = PathUtilities.join(root, binRelative)
        guard binDirectory.hasPrefix(root + "/") else {
            throw NativeRuntimeError("POSTGRES_RUNTIME_CORRUPT", "Packaged PostgreSQL binary path is unsafe")
        }
        return binDirectory
    }

    /// Verifies the payload (hashing it on the first launch of an installed payload, ADR-235)
    /// and discovers every tool (`discover`). Vision Native only supports the packaged,
    /// managed PostgreSQL and the compiled backend. `verification` receives how the payload
    /// was verified (`recordBootPhase("runtime_manifest_<mode>")` in Electron).
    public static func discoverTools(
        runtimeRoot: String,
        markerPath: String,
        fileSystem: any RuntimeFileSystem,
        runner: any ProcessRunning,
        childEnvironment: [String: String],
        verification: (RuntimeVerificationMode) -> Void = { _ in }
    ) async throws -> NativeTools {
        let verified = try verifyManifestOnLaunch(
            runtimeRoot: runtimeRoot, markerPath: markerPath, fileSystem: fileSystem)
        verification(verified.mode)
        guard let binDirectory = try postgresBinDirectory(runtimeRoot: runtimeRoot, fileSystem: fileSystem),
            RuntimeConstants.requiredPostgresTools.allSatisfy({
                fileSystem.isExecutable(PathUtilities.join(binDirectory, $0))
            })
        else {
            throw NativeRuntimeError(
                "POSTGRES_NOT_FOUND",
                "Vision Native's packaged PostgreSQL \(RuntimeConstants.postgresVersion) runtime was not found. "
                    + "Reinstall with ./install-native.sh or prepare the native runtime before starting.")
        }
        var versions: [String: String] = [:]
        var versionNumbers: [String: Int] = [:]
        for name in RuntimeConstants.versionCheckedPostgresTools {
            let result = try await runner.run(
                PathUtilities.join(binDirectory, name), ["--version"],
                options: RunOptions(environment: childEnvironment, timeout: 10))
            let output = "\(result.stdout)\n\(result.stderr)"
            try PostgresSQL.assertMajor18(name, output)
            versions[name] = output.trimmingCharacters(in: .whitespacesAndNewlines)
            versionNumbers[name] = PostgresSQL.parseVersionNumber(output)
        }
        let compiledBackend = PathUtilities.join(runtimeRoot, "vision-backend")
        guard fileSystem.isExecutable(compiledBackend) else {
            throw NativeRuntimeError(
                "BUN_NOT_FOUND", "Bun was not found and no packaged Vision backend executable is available.")
        }
        return NativeTools(
            binDirectory: binDirectory,
            versions: versions,
            versionNumbers: versionNumbers,
            compiledBackend: compiledBackend
        )
    }
}
