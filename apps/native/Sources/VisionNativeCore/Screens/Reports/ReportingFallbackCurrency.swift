import Foundation

/// The currency the analysis, AI, report and research screens fall back to when no valid
/// currency is configured: the web app's `EUR` default (`DEFAULT_CURRENCY`).
public enum ReportingFallbackCurrency {
    public static let euro: CurrencyCode = CurrencyCode(rawValue: "EUR")! // lint:allow force-unwrap fixed three-letter literal

    /// The configured currency (typed or as settings text) when it is a valid code, else the fallback.
    public static func resolve<Value: CustomStringConvertible>(_ configured: Value) -> CurrencyCode {
        CurrencyCode(rawValue: configured.description) ?? euro
    }
}
