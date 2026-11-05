import Foundation
import VisionNativeCore

/// The formatted text of recently drawn amounts. `Decimal.FormatStyle` builds an ICU formatter
/// on every call, and a ledger row formats its amount for the cell and again for its
/// accessibility label; a fling past a few hundred rows redraws the same amounts as rows leave
/// and re-enter the lazy stack. The key holds everything the text depends on.
@MainActor
final class MoneyTextCache {
    static let shared = MoneyTextCache()

    struct Key: Hashable {
        let amount: Decimal
        let currency: CurrencyCode
        let localeIdentifier: String
        let fractionDigits: Int
        let signed: Bool
    }

    /// Entries kept before the cache starts over (a few thousand short strings).
    nonisolated static let capacity = 4096

    private var entries: [Key: String] = [:]
    private(set) var misses = 0

    init() {}

    func text(
        _ amount: Decimal, currency: CurrencyCode, locale: Locale, fractionDigits: Int, signed: Bool
    ) -> String {
        let key = Key(
            amount: amount, currency: currency, localeIdentifier: locale.identifier,
            fractionDigits: fractionDigits, signed: signed)
        if let hit = entries[key] { return hit }
        misses += 1
        let text = VisionFormat.currency(
            amount, code: currency, locale: locale, fractionDigits: fractionDigits, signed: signed)
        if entries.count >= Self.capacity { entries.removeAll(keepingCapacity: true) }
        entries[key] = text
        return text
    }
}
