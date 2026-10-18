import Foundation

/// Values shared with the Electron native runtime (`packaging/electron/runtime/native.ts`).
/// They are persistence contracts (packaging/AGENTS.md): change them only together with
/// the Electron runtime and a migration plan.
public enum RuntimeConstants {
    public static let postgresMajor = 18
    public static let postgresMinor = 6
    public static let postgresVersion = "\(postgresMajor).\(postgresMinor)"
    public static let chromiumVersion = "150.0.7871.24"
    public static let loopbackHost = "127.0.0.1"
    /// `DEFAULT_POSTGRES_PORT`: the port a URL without a port means.
    public static let defaultPostgresPort = 54329
    /// `DEFAULT_APP_PORT`: last-resort backend port when no random port is free.
    public static let defaultAppPort = 3002
    /// `pickRandomFreePort` in `packaging/electron/main.ts`: 20000–59999, 64 tries.
    public static let randomAppPortRange = 20000...59999
    public static let randomAppPortAttempts = 64
    /// `resolveAppPort`: the persisted `appPort` bounds.
    public static let persistedAppPortRange = 1024...65535
    public static let runtimeManagedMaterializedViews = ["mv_monthly_summary", "mv_category_totals"]
    public static let requiredPostgresExtensions = ["pg_trgm", "pgcrypto", "pg_stat_statements"]
    public static let requiredPostgresTools = [
        "postgres", "initdb", "pg_ctl", "psql", "pg_dump", "pg_restore", "pg_isready", "createdb", "dropdb",
    ]
    public static let versionCheckedPostgresTools = ["postgres", "psql", "pg_dump", "pg_restore"]
    public static let analysisRole = "vision_analysis_executor"
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

/// Vision Native's own identity (ADR-204). It never shares a data directory, runtime id
/// or PostgreSQL port with the Electron "Vision" (54329) or "Vision Demo" (54330) apps.
public enum VisionNativeIdentity {
    public static let userDataName = "Vision Native"
    public static let runtimeId = "vision_native"
    public static let postgresPort = 54331
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
