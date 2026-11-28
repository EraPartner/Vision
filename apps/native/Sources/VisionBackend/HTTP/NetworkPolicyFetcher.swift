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

    public func getWithoutRedirects(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
        if !Self.isLoopback(url) { try await preflight() }
        return try await base.getWithoutRedirects(url, timeout: timeout)
    }

    /// The wrapped fetcher's resolver, so a test fetcher's recorded answer survives the gate.
    public func resolve(_ host: String) throws -> [String] {
        try base.resolve(host)
    }

    /// `isLoopbackHost`: localhost, 127.0.0.0/8 and ::1.
    static func isLoopback(_ url: URL) -> Bool {
        guard let host = url.host(percentEncoded: false)?.lowercased() else { return false }
        if ["localhost", "::1", "[::1]"].contains(host) { return true }
        return host.range(of: #"^(::ffff:)?127(\.\d{1,3}){3}$"#, options: .regularExpression) != nil
    }
}

extension NetworkPolicy {
    /// The policy stored in `app_settings`; the defaults when nothing is stored. A read that
    /// fails (a busy or unreadable file) fails closed as offline mode, so a database hiccup can
    /// never send a request the saved privacy choice forbids.
    static func stored(in database: BackendDatabase) async -> NetworkPolicy {
        do {
            let value = try await database.run { session -> JSValue? in
                guard let row = try session.row("SELECT value FROM user_settings WHERE key = ?", [.text("app_settings")])
                else { return nil }
                return SettingsArea.revive(key: "app_settings", try SettingsArea.stored(row))
            }
            return from(appSettings: value)
        } catch {
            return unreadable
        }
    }

    /// The policy while the stored one cannot be read: nothing leaves the Mac.
    static var unreadable: NetworkPolicy {
        var policy = NetworkPolicy.defaults
        policy.offlineMode = true
        return policy
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
