import Foundation
import Synchronization

/// `priceRefresh` in `app_settings` (Settings › Privacy, ADR-271): how often holdings' prices are
/// fetched without the user asking. The Bun backend's warmup schedule reads it.
public enum PriceRefresh: String, CaseIterable, Sendable {
    case hourly
    case daily
    case manual
}

/// `updateCheck` in `app_settings`: whether the app looks for a new release by itself.
public enum UpdateCheck: String, CaseIterable, Sendable {
    case daily
    case manual
}

/// The network part of Settings › Privacy (ADR-271), as `parseNetworkPolicy` in
/// apps/node-backend/src/lib/networkPolicy.ts reads it from `app_settings`. The Swift backend
/// gates its provider fetches with it and the app shell gates its own requests (update checks,
/// logos, news thumbnails) with `offlineMode`.
public struct NetworkPolicy: Equatable, Sendable {
    /// A data source the user can switch off on its own.
    public enum Source: String, CaseIterable, Sendable {
        /// ECB and open.er-api.com exchange rates.
        case exchangeRates
        /// Statbel and Eurostat inflation.
        case inflation
        /// Prices, market lookup and research: Yahoo, Binance, Kinesis, custom price URLs and
        /// the research providers. These requests carry the tickers of the user's holdings.
        case marketData

        /// The `app_settings` field that holds the switch.
        public var settingsField: String {
            switch self {
            case .exchangeRates: return "networkExchangeRates"
            case .inflation: return "networkInflation"
            case .marketData: return "networkMarketData"
            }
        }
    }

    /// Nothing leaves the Mac; loopback (the bundled backend, a local Ollama) stays allowed.
    public var offlineMode = false
    public var exchangeRates = true
    public var inflation = true
    public var marketData = true
    public var priceRefresh: PriceRefresh = .hourly
    /// Refuse an Ollama endpoint that is not on this Mac.
    public var aiLocalOnly = false

    public init() {}

    /// Everything on, hourly prices: today's behaviour.
    public static let defaults = NetworkPolicy()

    public func isEnabled(_ source: Source) -> Bool {
        switch source {
        case .exchangeRates: return exchangeRates
        case .inflation: return inflation
        case .marketData: return marketData
        }
    }

    /// True when the policy lets the app use `source`.
    public func allows(_ source: Source) -> Bool { !offlineMode && isEnabled(source) }

    /// The policy in an `app_settings` object, read through `bool` and `string` lookups of its
    /// fields: a missing field or one of the wrong type reads as its default.
    public static func read(bool: (String) -> Bool?, string: (String) -> String?) -> NetworkPolicy {
        var policy = NetworkPolicy()
        if let value = bool("offlineMode") { policy.offlineMode = value }
        if let value = bool(Source.exchangeRates.settingsField) { policy.exchangeRates = value }
        if let value = bool(Source.inflation.settingsField) { policy.inflation = value }
        if let value = bool(Source.marketData.settingsField) { policy.marketData = value }
        if let value = string("priceRefresh").flatMap(PriceRefresh.init(rawValue:)) { policy.priceRefresh = value }
        if let value = bool("aiLocalOnly") { policy.aiLocalOnly = value }
        return policy
    }
}

/// The offline switch as the shell's own requests see it: set when `app_settings` is applied,
/// read by the update checker and the image loaders before they reach the network. A lock, not
/// actor isolation, so nonisolated loaders can read it synchronously.
public final class NetworkAccess: Sendable {
    public static let shared = NetworkAccess()

    private let offline = Mutex(false)

    public init() {}

    public var isOffline: Bool { offline.withLock { $0 } }

    public func setOffline(_ value: Bool) { offline.withLock { $0 = value } }
}

/// The error a request refused by Settings › Privacy throws.
public struct NetworkBlockedError: Error, Equatable, Sendable {
    public enum Reason: String, Sendable {
        case offline
        case sourceOff
    }

    public let reason: Reason

    public init(_ reason: Reason) { self.reason = reason }
}
