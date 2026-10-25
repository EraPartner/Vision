import Foundation

/// Currency helpers the ledger screens (accounts, transactions, planned payments, owes,
/// categories, recipients, exchange rates, home, net worth, statistics) share.
public enum LedgerCurrency {
    /// `"EUR"`: the fallback of `currency ?? "EUR"` and `defaultCurrency || "EUR"`.
    public static let eur: CurrencyCode = .eur

    /// `appSettings.defaultCurrency || "EUR"`: settings already hold a validated, upper-case code.
    public static func display(_ settings: NativeAppSettings) -> CurrencyCode {
        settings.defaultCurrency
    }
}
