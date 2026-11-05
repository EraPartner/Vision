import Foundation

/// Report-boundary helpers for currencies that arrive as settings text.
enum NativeReportCurrency {
    /// Whether a page model's currency is the configured default currency. The page models hand over
    /// their currency typed (`CurrencyCode`) or as the settings text; both compare by wire text.
    static func matches<Value: CustomStringConvertible>(_ currency: Value, _ settingsCurrency: some CustomStringConvertible) -> Bool {
        currency.description == settingsCurrency.description
    }
}
