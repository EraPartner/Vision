import Foundation

/// Currency helpers the ledger screens (accounts, transactions, planned payments, owes,
/// categories, recipients, exchange rates, home, net worth, statistics) share.
public enum LedgerCurrency {
    /// `"EUR"`: the fallback of `currency ?? "EUR"` and `defaultCurrency || "EUR"`.
    public static let eur: CurrencyCode = {
        if let code = CurrencyCode(rawValue: "EUR") { return code }
        // lint:allow fatal-error "EUR" is a literal that always matches the currency pattern
        preconditionFailure("EUR is a valid currency code")
    }()

    /// `appSettings.defaultCurrency || "EUR"` as a validated code: the stored code in capitals,
    /// else EUR for an empty or malformed value.
    public static func display(_ settings: NativeAppSettings) -> CurrencyCode {
        CurrencyCode(rawValue: settings.defaultCurrency.uppercased()) ?? eur
    }
}
