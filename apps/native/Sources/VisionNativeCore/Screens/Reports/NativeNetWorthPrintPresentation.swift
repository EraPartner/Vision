import Foundation

/// No service graph or mutable page model is involved in current-view print formatting.
@MainActor public final class NativeNetWorthPrintPresentation {
    public let snapshot: NativeNetWorthPrintSnapshot
    private init(snapshot: NativeNetWorthPrintSnapshot) { self.snapshot = snapshot }
    public static func prepare(_ snapshot: NativeNetWorthPrintSnapshot) -> NativeNetWorthPrintPresentation {
        NativeNetWorthPrintPresentation(snapshot: snapshot)
    }
    public func money(_ value: Decimal, signed: Bool = false) -> String {
        VisionFormat.currency(
            value, code: snapshot.currency, locale: snapshot.settings.numberFormat.locale,
            fractionDigits: snapshot.settings.showDecimalPlaces, signed: signed)
    }
    public func percent(_ value: Decimal) -> String {
        (value > 0 ? "+" : "") + VisionFormat.percent(value, locale: snapshot.settings.numberFormat.locale)
    }
    public func date(_ value: String) -> String {
        VisionFormat.appDate(value, format: snapshot.settings.dateFormat)
    }
    public func tick(_ value: String) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.calendar = Calendar(identifier: .gregorian)
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: value) else { return value }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: snapshot.strings.language == .nl ? "nl_NL" : "en_US")
        formatter.dateFormat = [.month, .quarter, .halfYear].contains(snapshot.period) ? "d MMM" : "MMM yy"
        return formatter.string(from: date)
    }
}
