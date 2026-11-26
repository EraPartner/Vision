import Foundation
import Synchronization
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Settings › Privacy (ADR-271): the policy as `parseNetworkPolicy` reads it, and the gate in
/// front of the Swift backend's provider fetches.
struct NetworkPolicyFetcherTests {
    final class CountingFetcher: ProviderFetching {
        let urls = Mutex<[String]>([])
        func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
            urls.withLock { $0.append(url.absoluteString) }
            return ProviderResponse(status: 200, body: Data("{}".utf8))
        }
    }

    final class PolicyBox: Sendable {
        let policy: Mutex<NetworkPolicy>
        init(_ policy: NetworkPolicy) { self.policy = Mutex(policy) }
    }

    @Test func policyReadsEachFieldAndFallsBackPerField() {
        #expect(NetworkPolicy.from(appSettings: nil) == .defaults)
        #expect(NetworkPolicy.from(appSettings: .array([.bool(true)])) == .defaults)
        let policy = NetworkPolicy.from(
            appSettings: .object(
                JSObject([
                    ("offlineMode", .bool(true)), ("networkExchangeRates", .bool(false)),
                    ("networkInflation", .string("no")), ("priceRefresh", .string("weekly")),
                    ("aiLocalOnly", .bool(true)),
                ])))
        #expect(policy.offlineMode && !policy.exchangeRates && policy.inflation && policy.marketData)
        #expect(policy.priceRefresh == .hourly && policy.aiLocalOnly)
    }

    @Test func switchedOffSourceAndOfflineModeRefuseBeforeTheRequest() async throws {
        let base = CountingFetcher()
        var policy = NetworkPolicy()
        policy.marketData = false
        let current = PolicyBox(policy)
        let read: @Sendable () async -> NetworkPolicy = { current.policy.withLock { $0 } }
        let market = NetworkPolicyFetcher(base, source: .marketData, policy: read)
        let rates = NetworkPolicyFetcher(base, source: .exchangeRates, policy: read)

        await #expect(throws: NetworkBlockedError(.sourceOff)) {
            try await market.get(URL(string: "https://query1.finance.yahoo.com/v8")!, timeout: 1)
        }
        await #expect(throws: NetworkBlockedError(.sourceOff)) { try await market.preflight() }
        _ = try await rates.get(URL(string: "https://www.ecb.europa.eu/x")!, timeout: 1)

        current.policy.withLock { $0.offlineMode = true }
        await #expect(throws: NetworkBlockedError(.offline)) {
            try await rates.get(URL(string: "https://www.ecb.europa.eu/x")!, timeout: 1)
        }
        // Loopback stays reachable in offline mode.
        _ = try await rates.get(URL(string: "http://127.0.0.1:3002/health")!, timeout: 1)
        #expect(base.urls.withLock { $0 } == ["https://www.ecb.europa.eu/x", "http://127.0.0.1:3002/health"])
    }
}
