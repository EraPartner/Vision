import Foundation

extension Decimal {
    /// An exact decimal from a source literal, such as `Decimal.literal("0.005")`.
    ///
    /// `Decimal(0.005)` goes through `Double` and is inexact, and `Decimal(string:)` returns an
    /// optional. `StaticString` restricts the argument to literals written in the source, so a
    /// malformed one is a programming error that the first call reveals.
    public static func literal(_ text: StaticString) -> Decimal {
        guard let value = Decimal(string: text.description, locale: Locale(identifier: "en_US_POSIX")) else {
            preconditionFailure("Invalid decimal literal \(text)")  // lint:allow fatal-error source literal, never runtime input
        }
        return value
    }
}

extension URL {
    /// A URL from a source literal. `StaticString` restricts the argument to literals written in
    /// the source, so a malformed one is a programming error that the first call reveals.
    public static func literal(_ text: StaticString) -> URL {
        guard let url = URL(string: text.description) else {
            preconditionFailure("Invalid URL literal \(text)")  // lint:allow fatal-error source literal, never runtime input
        }
        return url
    }
}
