import Foundation

/// Child-process environments (`safeChildEnv`, `buildNativeBackendEnv` and the database
/// tool's environment in `packaging/electron/runtime/native.ts`). A child gets only the
/// allowlisted host variables plus explicit overrides, never the app's full environment.
public enum ChildEnvironment {
    /// `safeChildEnv`: allowlisted inherited keys, then overrides (a `nil` override is
    /// skipped like `undefined`), then the inherited `PATH` followed by the Homebrew and
    /// system directories.
    public static func safe(
        inherited: [String: String],
        overrides: [(String, String?)] = []
    ) -> [String: String] {
        var environment: [String: String] = [:]
        for key in RuntimeConstants.childEnvironmentAllowlist {
            if let value = inherited[key] { environment[key] = value }
        }
        for (key, value) in overrides {
            if let value { environment[key] = value }
        }
        environment["PATH"] = [inherited["PATH"] ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
            .filter { !$0.isEmpty }
            .joined(separator: ":")
        return environment
    }

    /// `withoutRetiredEnv`: the runtime environment minus the settings of removed features.
    public static func withoutRetired(_ environment: [String: String]) -> [String: String] {
        environment.filter { !RuntimeConstants.retiredEnvironmentKeys.contains($0.key) }
    }

    /// `systemTimeZone`: the Mac's IANA zone for the backend's `APP_TIMEZONE` (ADR-264), so
    /// the backend's "today" is the same calendar day as the app's. `nil` when the host
    /// reports no usable zone, so the backend keeps its own default.
    public static func systemTimeZone(_ zone: TimeZone = .current) -> String? {
        let identifier = zone.identifier
        guard !identifier.isEmpty, TimeZone(identifier: identifier) != nil else { return nil }
        return identifier
    }

    /// `buildNativeBackendEnv` for the packaged backend. Vision Native never runs the
    /// synthetic smoke mode (`VISION_SYNTHETIC_SMOKE_OFFLINE` is always removed). The
    /// backend opens `VISION_DATABASE_PATH` and migrates it from
    /// `VISION_RUNTIME_ROOT/db/migrations`; it finds its Apple Foundation Models helper
    /// (`vision-apple-ai`) and the analysis sandbox itself, from `VISION_RUNTIME_ROOT`.
    public static func backend(
        inherited: [String: String],
        runtimeEnvironment: [String: String],
        port: Int,
        layout: RuntimeLayout,
        runtimeRoot: String,
        timeZone: String? = systemTimeZone()
    ) -> [String: String] {
        // `{ ...runtimeEnv, KEY: value }`: a later `undefined` (nil) replaces an earlier
        // value and is then skipped, so it removes that key from the overrides.
        var merged: [String: String?] = withoutRetired(runtimeEnvironment).mapValues { Optional($0) }
        // An explicit APP_TIMEZONE in runtime.env still wins.
        let explicitZone = runtimeEnvironment["APP_TIMEZONE"].flatMap { $0.isEmpty ? nil : $0 }
        let fixed: [(String, String?)] = [
            ("APP_TIMEZONE", explicitZone ?? timeZone),
            ("SERVER_HOST", RuntimeConstants.loopbackHost),
            ("PORT", String(port)),
            ("NODE_ENV", "production"),
            ("ENVIRONMENT", "production"),
            ("VISION_DATABASE_PATH", layout.database),
            ("ATTACHMENTS_DIR", layout.attachments),
            ("VISION_RUNTIME_ROOT", runtimeRoot),
            ("VISION_NATIVE_ENV_FILE", layout.env),
            ("VISION_DIST_DIR", PathUtilities.join(runtimeRoot, "dist")),
            ("OLLAMA_URL", "http://127.0.0.1:11434"),
            ("VISION_SYNTHETIC_SMOKE_OFFLINE", nil),
        ]
        for (key, value) in fixed {
            merged.updateValue(value, forKey: key)
        }
        let overrides: [(String, String?)] = merged.keys.sorted().map { key in (key, merged[key] ?? nil) }
        return safe(inherited: inherited, overrides: overrides)
    }

    /// The environment of `tools/db-file.js`, which the packaged backend executable runs as
    /// Bun (`databaseToolCommand`): production mode, no `.env` files, and the live database
    /// path, so the tool reports pending migrations against this payload.
    public static func databaseTool(inherited: [String: String], layout: RuntimeLayout, runtimeRoot: String)
        -> [String: String]
    {
        safe(
            inherited: inherited,
            overrides: [
                ("NODE_ENV", "production"),
                ("ENVIRONMENT", "production"),
                ("VISION_SKIP_DOTENV", "1"),
                ("VISION_RUNTIME_ROOT", runtimeRoot),
                ("VISION_DATABASE_PATH", layout.database),
                ("BUN_BE_BUN", "1"),
            ])
    }
}
