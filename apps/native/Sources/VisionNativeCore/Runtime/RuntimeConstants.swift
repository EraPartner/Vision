import Foundation

/// Values shared with the Electron native runtime (`packaging/electron/runtime/native.ts`).
/// They are persistence contracts (packaging/AGENTS.md): change them only together with
/// the Electron runtime and a migration plan.
public enum RuntimeConstants {
    /// `RUNTIME_VERIFICATION_MARKER`: records the last full payload verification, below the
    /// runtime's `nativeRoot`.
    public static let runtimeVerificationMarker = "runtime-verification.json"
    public static let loopbackHost = "127.0.0.1"
    /// `DEFAULT_APP_PORT`: last-resort backend port when no random port is free.
    public static let defaultAppPort = 3002
    /// `pickRandomFreePort` in `packaging/electron/main.ts`: 20000–59999, 64 tries.
    public static let randomAppPortRange = 20000...59999
    public static let randomAppPortAttempts = 64
    /// `resolveAppPort`: the persisted `appPort` bounds.
    public static let persistedAppPortRange = 1024...65535
    /// `DATABASE_DIRECTORY_NAME`: `<userData>/database` holds one database generation (the
    /// file, its `-wal` and `-shm` sidecars and the backend's `pre-migration-backups/`), so
    /// a restore swaps the whole directory and a write-ahead log never sits beside the wrong
    /// database (ADR-263).
    public static let databaseDirectoryName = "database"
    /// `DATABASE_FILE_NAME`: the backend's `VISION_DATABASE_PATH` inside that directory.
    public static let databaseFileName = "vision.sqlite3"
    /// `PREVIOUS_DATABASE_GENERATIONS_KEPT`: previous generations kept after a committed restore.
    public static let previousDatabaseGenerationsKept = 3
    /// `PACKAGED_DATABASE_TOOL`: run by the backend executable as Bun (`BUN_BE_BUN=1`).
    public static let packagedDatabaseTool = "tools/db-file.js"
    /// `PACKAGED_ANALYSIS_SANDBOX`: the analysis SQL sandbox the backend starts itself.
    public static let packagedAnalysisSandbox = "tools/analysis-sandbox.js"
    /// `NATIVE_APPLICATION_ENV_KEYS`: the market-data keys `importApplicationEnv` copies
    /// into `runtime.env`.
    public static let applicationEnvironmentKeys = [
        "TWELVE_DATA_API_KEY", "FINNHUB_API_KEY", "FMP_API_KEY", "ALPHA_VANTAGE_API_KEY", "FRED_API_KEY",
    ]
    /// `RETIRED_NATIVE_ENV_KEYS`: settings of removed features (cloud AI, AI reference
    /// mapping and the database server older versions ran). An older `runtime.env` may still
    /// hold them; they are stripped on the next layout check and never reach a child.
    public static let retiredEnvironmentKeys: Set<String> = [
        "OPENAI_API_KEY", "OPENAI_API_ENABLED", "AI_REFERENCE_MAPPING_KEY", "DATABASE_URL",
        "DATABASE_URL_MIGRATIONS", "DATABASE_URL_ANALYSIS", "VISION_POSTGRES_ADMIN_ROLE",
        "VISION_POSTGRES_ADMIN_PASSWORD",
    ]
    public static let childEnvironmentAllowlist = [
        "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    ]
    /// `process.platform` and `process.arch` as the payload metadata records them.
    public static let payloadPlatform = "darwin"
    public static var payloadArchitecture: String {
        #if arch(arm64)
            return "arm64"
        #else
            return "x64"
        #endif
    }
}

/// Vision Native's own identity (ADR-204). It never shares a data directory or runtime id
/// with the Electron "Vision" or "Vision Demo" apps.
public enum VisionNativeIdentity {
    public static let userDataName = "Vision Native"
    public static let runtimeId = "vision_native"
    /// Electron application-data folders Vision Native must never read, lock or mutate.
    public static let foreignUserDataNames: Set<String> = ["Vision", "Vision Demo", "Vision Development"]

    /// `~/Library/Application Support/Vision Native`.
    public static func userDataDirectory(homeDirectory: String) -> String {
        PathUtilities.join(homeDirectory, "Library", "Application Support", userDataName)
    }
}

/// An error with the machine-readable `code` the Electron runtime attaches.
public struct NativeRuntimeError: Error, Equatable, Sendable, LocalizedError, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
    public var description: String { "\(message) [\(code)]" }
}

/// Small string and path helpers with Node `path` semantics.
public enum PathUtilities {
    /// `path.join`: joins with `/` and normalizes `.`/`..` lexically.
    public static func join(_ parts: String...) -> String {
        join(parts)
    }

    public static func join(_ parts: [String]) -> String {
        let joined = parts.filter { !$0.isEmpty }.joined(separator: "/")
        return normalize(joined)
    }

    /// Lexical normalization like `path.normalize` (no symlink resolution).
    public static func normalize(_ path: String) -> String {
        let absolute = path.hasPrefix("/")
        var stack: [String] = []
        for component in path.split(separator: "/", omittingEmptySubsequences: true) {
            if component == "." { continue }
            if component == ".." {
                if let last = stack.last, last != ".." {
                    stack.removeLast()
                } else if !absolute {
                    stack.append("..")
                }
                continue
            }
            stack.append(String(component))
        }
        let body = stack.joined(separator: "/")
        if absolute { return "/" + body }
        return body.isEmpty ? "." : body
    }

    public static func basename(_ path: String) -> String {
        let trimmed = normalize(path)
        if trimmed == "/" { return "" }
        return trimmed.split(separator: "/").last.map(String.init) ?? ""
    }

    public static func dirname(_ path: String) -> String {
        let normalized = normalize(path)
        guard let slash = normalized.lastIndex(of: "/") else { return "." }
        if slash == normalized.startIndex { return "/" }
        return String(normalized[..<slash])
    }

    /// Whether `value` fully matches the ICU regular expression `pattern`.
    public static func fullMatch(_ value: String, _ pattern: String) -> Bool {
        value.range(of: "^(?:\(pattern))$", options: .regularExpression) != nil
    }

    /// Whether `value` contains a match of the ICU regular expression `pattern`.
    public static func contains(_ value: String, _ pattern: String, caseInsensitive: Bool = false) -> Bool {
        var options: String.CompareOptions = [.regularExpression]
        if caseInsensitive { options.insert(.caseInsensitive) }
        return value.range(of: pattern, options: options) != nil
    }

    /// Capture groups of the first match, `nil` for a group that did not participate.
    public static func firstMatchGroups(
        _ value: String,
        _ pattern: String,
        caseInsensitive: Bool = false
    ) -> [String?]? {
        guard
            let regex = try? NSRegularExpression(
                pattern: pattern,
                options: caseInsensitive ? [.caseInsensitive] : []
            ),
            let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value))
        else {
            return nil
        }
        return (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            guard range.location != NSNotFound, let swiftRange = Range(range, in: value) else { return nil }
            return String(value[swiftRange])
        }
    }

    public static func isSHA256(_ value: String) -> Bool {
        fullMatch(value, "[0-9a-f]{64}")
    }
}
