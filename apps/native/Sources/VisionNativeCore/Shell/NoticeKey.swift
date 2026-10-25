import Foundation

/// The notices that replace their predecessor instead of stacking (`NativeNoticeCenter.publish`'s
/// `replacementKey`), the native counterpart of Sonner's toast `id`. The raw values are the ids the
/// web app uses, so a notice published again under the same case updates the toast on screen.
public enum NoticeKey: String, CaseIterable, Hashable, Sendable {
    /// The portfolio's "refresh prices" progress and result.
    case portfolioRefreshPrices = "portfolio-refresh-prices"
    /// The backend health banner.
    case backendHealth = "backend-health"
}

/// A key of the String Catalog (`apps/native/i18n-keys.txt`), so a notice action's title cannot be
/// confused with free text. The generated key enum of the i18n work replaces this wrapper; until then
/// the string literal form keeps call sites as they were.
public struct LocalizedKey: RawRepresentable, Hashable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        self.rawValue = value
    }

    public var description: String { rawValue }
}
