import Foundation

/// Where the runtime payload (PostgreSQL, the compiled backend, Alembic, Chrome
/// Headless Shell) and the synthetic Demo seed were found.
public struct RuntimePayloadLocation: Sendable, Equatable {
    public enum Source: Sendable, Equatable {
        case environment
        case appBundle
    }

    /// The prepared `native-runtime` tree (`manifest.json`, `postgres/`, `vision-backend`, …).
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
    public let alembic: String
    public let compiledBackend: String
    public let chrome: String?

    public func tool(_ name: String) -> String {
        PathUtilities.join(binDirectory, name)
    }
}

/// Payload discovery and verification, ported from `verifyRuntimeManifest`,
/// `bundledPostgresBin`, `discoverPostgres18`, `bundledChromiumPath`, `discoverChrome`
/// and `resolveAlembic` in `packaging/electron/runtime/native.ts`.
public enum RuntimePayload {
    /// Development override: an absolute path to a prepared `native-runtime` directory.
    /// Honoured in Debug builds only.
    public static let environmentKey = "VISION_NATIVE_RUNTIME_DIR"
    /// `Contents/Resources/runtime` in the app bundle (install-native.sh stages it).
    public static let bundleDirectoryName = "runtime"
    public static let demoSeedDirectoryName = "demo-seed"

    public static let missingPayloadMessage =
        "This Vision Native build has no runtime payload (PostgreSQL 18, the backend and Chrome Headless Shell). "
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

    /// `verifyRuntimeManifest(root, { required: true })`: every file is listed with its
    /// size and SHA-256, no entry escapes the root, and nothing unlisted, symlinked or
    /// special exists. Returns the number of entries.
    @discardableResult
    public static func verifyManifest(runtimeRoot: String, fileSystem: any RuntimeFileSystem) throws -> Int {
        let manifest: JSONValue
        do {
            manifest = try JSONValue.parse(try fileSystem.readFile(PathUtilities.join(runtimeRoot, "manifest.json")))
        } catch {
            throw corrupt("Native runtime manifest is missing or invalid")
        }
        guard manifest["version"] == .int(1), let entries = manifest["entries"]?.arrayValue else {
            throw corrupt("Native runtime manifest has an unsupported format")
        }
        var expected = Set<String>()
        for entry in entries {
            guard let relative = entry["path"]?.stringValue,
                PathUtilities.fullMatch(relative, "[A-Za-z0-9._@+/-]+"),
                !relative.hasPrefix("/"),
                !relative.split(separator: "/", omittingEmptySubsequences: false).contains(".."),
                let digest = entry["sha256"]?.stringValue,
                PathUtilities.isSHA256(digest),
                !expected.contains(relative)
            else {
                throw corrupt("Native runtime manifest contains an invalid entry")
            }
            expected.insert(relative)
            let absolute = PathUtilities.join(runtimeRoot, relative)
            let actual: (bytes: Int, hex: String)
            do {
                actual = try fileSystem.sha256(absolute)
            } catch {
                throw corrupt("Native runtime payload is missing \(relative)")
            }
            guard entry["bytes"]?.intValue == actual.bytes, actual.hex == digest else {
                throw corrupt("Native runtime payload failed checksum verification: \(relative)")
            }
        }
        var actualPaths = Set<String>()
        func visit(_ directory: String, _ prefix: String) throws {
            for name in try fileSystem.contentsOfDirectory(directory) {
                let absolute = PathUtilities.join(directory, name)
                let relative = prefix.isEmpty ? name : "\(prefix)/\(name)"
                switch fileSystem.info(absolute)?.kind {
                case .directory?:
                    try visit(absolute, relative)
                case .file?:
                    if relative != "manifest.json" { actualPaths.insert(relative) }
                default:
                    throw corrupt("Native runtime payload contains an unsupported entry: \(relative)")
                }
            }
        }
        try visit(runtimeRoot, "")
        guard actualPaths == expected else {
            throw corrupt("Native runtime payload contains files not covered by its manifest")
        }
        return entries.count
    }

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

    /// `bundledChromiumPath`: `chromium/runtime.json` must pin the Chrome Headless Shell
    /// version for this platform, and the executable must stay inside `chromium/`.
    public static func chromiumExecutable(runtimeRoot: String, fileSystem: any RuntimeFileSystem) throws -> String?
    {
        let chromiumRoot = PathUtilities.join(runtimeRoot, "chromium")
        guard let data = try fileSystem.readIfPresent(PathUtilities.join(chromiumRoot, "runtime.json")) else {
            return nil
        }
        guard let metadata = try? JSONValue.parse(data) else {
            throw NativeRuntimeError("CHROMIUM_RUNTIME_CORRUPT", "Packaged Chromium metadata is invalid")
        }
        guard metadata.objectValue != nil,
            metadata["version"] == .int(1),
            metadata["browser"] == .string("chrome-headless-shell"),
            metadata["browserVersion"] == .string(RuntimeConstants.chromiumVersion),
            metadata["platform"] == .string(RuntimeConstants.payloadPlatform),
            metadata["architecture"] == .string(RuntimeConstants.payloadArchitecture),
            let executableRelative = metadata["executableRelative"]?.stringValue,
            isSafeRelative(executableRelative)
        else {
            throw NativeRuntimeError(
                "CHROMIUM_RUNTIME_MISMATCH", "Packaged Chromium metadata does not match this Vision build")
        }
        let executable = PathUtilities.join(chromiumRoot, executableRelative)
        guard executable.hasPrefix(chromiumRoot + "/"), fileSystem.isExecutable(executable) else {
            throw NativeRuntimeError("CHROMIUM_RUNTIME_CORRUPT", "Packaged Chromium executable is missing or unsafe")
        }
        return executable
    }

    /// Host browsers `discoverChrome` falls back to after the packaged one.
    public static let hostBrowserCandidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/opt/homebrew/bin/chromium",
        "/usr/local/bin/chromium",
    ]

    /// `discoverChrome`: `PUPPETEER_EXECUTABLE_PATH`, the packaged shell, then host browsers.
    public static func discoverChrome(
        runtimeRoot: String,
        environment: [String: String],
        fileSystem: any RuntimeFileSystem
    ) throws -> String? {
        let bundled = try chromiumExecutable(runtimeRoot: runtimeRoot, fileSystem: fileSystem)
        let candidates: [String?] =
            [environment["PUPPETEER_EXECUTABLE_PATH"], bundled] + hostBrowserCandidates.map { Optional($0) }
        return candidates.compactMap { $0 }.first { !$0.isEmpty && fileSystem.isExecutable($0) }
    }

    /// Verifies the manifest and discovers every tool (`discover`). Vision Native only
    /// supports the packaged, managed PostgreSQL and the compiled backend.
    public static func discoverTools(
        runtimeRoot: String,
        environment: [String: String],
        fileSystem: any RuntimeFileSystem,
        runner: any ProcessRunning,
        childEnvironment: [String: String]
    ) async throws -> NativeTools {
        try verifyManifest(runtimeRoot: runtimeRoot, fileSystem: fileSystem)
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
        let alembic = try await resolveAlembic(
            runtimeRoot: runtimeRoot, environment: environment, fileSystem: fileSystem, runner: runner,
            childEnvironment: childEnvironment)
        let compiledBackend = PathUtilities.join(runtimeRoot, "vision-backend")
        guard fileSystem.isExecutable(compiledBackend) else {
            throw NativeRuntimeError(
                "BUN_NOT_FOUND", "Bun was not found and no packaged Vision backend executable is available.")
        }
        let chrome = try discoverChrome(runtimeRoot: runtimeRoot, environment: environment, fileSystem: fileSystem)
        return NativeTools(
            binDirectory: binDirectory,
            versions: versions,
            versionNumbers: versionNumbers,
            alembic: alembic,
            compiledBackend: compiledBackend,
            chrome: chrome
        )
    }

    /// `resolveAlembic`: the first executable candidate whose `--version` succeeds.
    static func resolveAlembic(
        runtimeRoot: String,
        environment: [String: String],
        fileSystem: any RuntimeFileSystem,
        runner: any ProcessRunning,
        childEnvironment: [String: String]
    ) async throws -> String {
        let optionalCandidates: [String?] = [
            PathUtilities.join(runtimeRoot, "vision-alembic"),
            environment["ALEMBIC_BIN"],
            "/opt/homebrew/bin/alembic",
            "/usr/local/bin/alembic",
        ]
        let candidates = optionalCandidates.compactMap { $0 }.filter { !$0.isEmpty }
        for candidate in candidates where fileSystem.isExecutable(candidate) {
            do {
                _ = try await runner.run(
                    candidate, ["--version"], options: RunOptions(environment: childEnvironment, timeout: 10))
                return candidate
            } catch {
                continue
            }
        }
        throw NativeRuntimeError(
            "ALEMBIC_NOT_FOUND",
            "Vision's packaged Alembic migration runtime was not found. Reinstall with ./install-native.sh or prepare the native runtime before starting."
        )
    }

    /// `assertNativeChromeAvailable`: PDF reports need a browser before the backend starts.
    public static func requireChrome(_ chrome: String?) throws -> String {
        guard let chrome else {
            throw NativeRuntimeError(
                "NATIVE_CHROMIUM_NOT_FOUND",
                "Vision's packaged Chrome Headless Shell was not found. Reinstall with ./install-native.sh or prepare the native runtime before starting."
            )
        }
        return chrome
    }
}
