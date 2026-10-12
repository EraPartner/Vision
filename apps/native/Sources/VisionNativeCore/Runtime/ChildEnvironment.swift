import Foundation

/// Child-process environments (`safeChildEnv`, `managedPostgresChildEnv` and
/// `buildNativeBackendEnv` in `packaging/electron/runtime/native.ts`). A child gets only
/// the allowlisted host variables plus explicit overrides, never the app's full
/// environment.
public enum ChildEnvironment {
    /// `safeChildEnv`: allowlisted inherited keys, then overrides (a `nil` override is
    /// skipped like `undefined`), then a `PATH` without any `postgresql@18/bin` entry
    /// followed by the Homebrew and system directories.
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
        let inheritedPath = (inherited["PATH"] ?? "")
            .split(separator: ":", omittingEmptySubsequences: false)
            .map(String.init)
            .filter { !PathUtilities.contains($0, #"/(?:opt/)?postgresql@18/bin/?$"#) }
            .joined(separator: ":")
        environment["PATH"] = [inheritedPath, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
            .filter { !$0.isEmpty }
            .joined(separator: ":")
        return environment
    }

    /// `managedPostgresChildEnv`: the portable C locale, never the host locale.
    public static func managedPostgres(inherited: [String: String]) -> [String: String] {
        safe(inherited: inherited, overrides: [("LANG", "C"), ("LC_ALL", "C"), ("LC_CTYPE", "C")])
    }

    /// `buildNativeBackendEnv` for the packaged backend. Vision Native passes no audit
    /// bridge token (phase 1e) and never runs the synthetic smoke mode.
    public static func backend(
        inherited: [String: String],
        runtimeEnvironment: [String: String],
        port: Int,
        layout: RuntimeLayout,
        runtimeRoot: String,
        alembic: String?,
        chrome: String?,
        auditBridgeToken: String? = nil
    ) -> [String: String] {
        let openAIEnabled =
            runtimeEnvironment["OPENAI_API_ENABLED"] == "true"
            && !(runtimeEnvironment["OPENAI_API_KEY"] ?? "").isEmpty
        // `{ ...runtimeEnv, KEY: value }`: a later `undefined` (nil) replaces an earlier
        // value and is then skipped, so it removes that key from the overrides.
        var merged: [String: String?] = runtimeEnvironment.mapValues { Optional($0) }
        let fixed: [(String, String?)] = [
            ("OPENAI_API_ENABLED", openAIEnabled ? "true" : "false"),
            ("OPENAI_API_KEY", openAIEnabled ? runtimeEnvironment["OPENAI_API_KEY"] : nil),
            ("SERVER_HOST", RuntimeConstants.loopbackHost),
            ("PORT", String(port)),
            ("NODE_ENV", "production"),
            ("ENVIRONMENT", "production"),
            ("ATTACHMENTS_DIR", layout.attachments),
            ("VISION_CACHE_DIR", layout.cache),
            ("VISION_RUNTIME_ROOT", runtimeRoot),
            ("VISION_NATIVE_ENV_FILE", layout.env),
            ("VISION_DIST_DIR", PathUtilities.join(runtimeRoot, "dist")),
            ("VISION_SKIP_CONFIG_ENV_LOCAL", "true"),
            ("ALEMBIC_BIN", alembic),
            ("ALEMBIC_CONFIG", PathUtilities.join(runtimeRoot, "config", "alembic.ini")),
            ("PUPPETEER_EXECUTABLE_PATH", chrome),
            ("OLLAMA_URL", "http://127.0.0.1:11434"),
            ("ADMIN_ALLOW_TOKENLESS_NONLOOPBACK", "false"),
            ("VISION_AUDIT_BRIDGE_TOKEN", auditBridgeToken),
            ("VISION_SYNTHETIC_SMOKE_OFFLINE", nil),
        ]
        for (key, value) in fixed {
            merged.updateValue(value, forKey: key)
        }
        let overrides: [(String, String?)] = merged.keys.sorted().map { key in (key, merged[key] ?? nil) }
        return safe(inherited: inherited, overrides: overrides)
    }
}
