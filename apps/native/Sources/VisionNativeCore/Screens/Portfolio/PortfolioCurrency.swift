import Foundation

/// The reporting currency of the portfolio, tax and import screens as a validated code.
/// `NativeAppSettings.defaultCurrency` is stored text (the settings page does not change its
/// case); the server requires `^[A-Z]{3}$`, so the code is upper-cased here, at the boundary.
public enum PortfolioCurrency {
    /// The app default (`NativeAppSettings.defaults`), used when the stored text is not a code.
    public static var eur: CurrencyCode { .eur }

    /// The code of stored settings text; `eur` when it is empty or not three letters.
    public static func code(_ text: String) -> CurrencyCode {
        CurrencyCode(rawValue: text.uppercased()) ?? .eur
    }

    /// The reporting currency of the current settings.
    public static func reporting(_ settings: NativeAppSettings) -> CurrencyCode {
        settings.defaultCurrency
    }
}

extension NativeAppSettings {
    /// `defaultCurrency` as the validated code the portfolio, tax and rebalance reads take.
    public var portfolioCurrency: CurrencyCode { PortfolioCurrency.reporting(self) }
}
