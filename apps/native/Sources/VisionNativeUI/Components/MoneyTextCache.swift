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

    /// Entries per generation (a few thousand short strings).
    nonisolated static let capacity = 4096

    /// Two generations: when `entries` fills, it becomes `previous` and a new one starts, so the
    /// amounts on screen survive the turnover instead of all being formatted again at once.
    private var entries: [Key: String] = [:]
    private var previous: [Key: String] = [:]
    private(set) var misses = 0

    init() {}

    func text(
        _ amount: Decimal, currency: CurrencyCode, locale: Locale, fractionDigits: Int, signed: Bool
    ) -> String {
        let key = Key(
            amount: amount, currency: currency, localeIdentifier: locale.identifier,
            fractionDigits: fractionDigits, signed: signed)
        if let hit = entries[key] { return hit }
        let text: String
        if let kept = previous[key] {
            text = kept
        } else {
            misses += 1
            text = VisionFormat.currency(
                amount, code: currency, locale: locale, fractionDigits: fractionDigits, signed: signed)
        }
        if entries.count >= Self.capacity {
            previous = entries
            entries = [:]
            entries.reserveCapacity(Self.capacity)
        }
        entries[key] = text
        return text
    }
}
