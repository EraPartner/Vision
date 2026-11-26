import Foundation
import VisionNativeCore

/// `assertNetworkAllowed(source)` of apps/node-backend/src/lib/networkPolicy.ts (ADR-271) in
/// front of a provider fetcher: a request to `source` is refused while offline mode is on or the
/// source is switched off in Settings › Privacy. Loopback addresses stay reachable. The policy is
/// read from `app_settings` on every request (one indexed row), so a change in the Privacy pane
/// applies to the next request.
public struct NetworkPolicyFetcher: ProviderFetching {
    let base: any ProviderFetching
    let source: NetworkPolicy.Source
    let policy: @Sendable () async -> NetworkPolicy

    public init(
        _ base: any ProviderFetching, source: NetworkPolicy.Source,
        policy: @escaping @Sendable () async -> NetworkPolicy
    ) {
        self.base = base
        self.source = source
        self.policy = policy
    }

    /// The fetcher an area uses: the policy read from `database`'s `app_settings`.
    init(_ base: any ProviderFetching, source: NetworkPolicy.Source, database: BackendDatabase) {
        self.init(base, source: source) { await NetworkPolicy.stored(in: database) }
    }

    public func preflight() async throws {
        let current = await policy()
        if current.offlineMode { throw NetworkBlockedError(.offline) }
        if !current.isEnabled(source) { throw NetworkBlockedError(.sourceOff) }
    }

    public func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
        if !Self.isLoopback(url) { try await preflight() }
        return try await base.get(url, timeout: timeout)
    }

    /// `isLoopbackHost`: localhost, 127.0.0.0/8 and ::1.
    static func isLoopback(_ url: URL) -> Bool {
        guard let host = url.host(percentEncoded: false)?.lowercased() else { return false }
        if ["localhost", "::1", "[::1]"].contains(host) { return true }
        return host.range(of: #"^(::ffff:)?127(\.\d{1,3}){3}$"#, options: .regularExpression) != nil
    }
}

extension NetworkPolicy {
    /// The policy stored in `app_settings`, or the defaults when it cannot be read (no database
    /// yet, a busy file): the defaults are today's behaviour, as `getNetworkPolicy` before the
    /// first read.
    static func stored(in database: BackendDatabase) async -> NetworkPolicy {
        let value = try? await database.run { session -> JSValue? in
            guard let row = try session.row("SELECT value FROM user_settings WHERE key = ?", [.text("app_settings")])
            else { return nil }
            return SettingsArea.revive(key: "app_settings", try SettingsArea.stored(row))
        }
        return from(appSettings: value ?? nil)
    }

    static func from(appSettings value: JSValue?) -> NetworkPolicy {
        guard let fields = value?.objectValue else { return .defaults }
        return read(
            bool: { name in
                if case .bool(let flag)? = fields[name] { return flag }
                return nil
            },
            string: { name in fields[name]?.stringValue })
    }
}
