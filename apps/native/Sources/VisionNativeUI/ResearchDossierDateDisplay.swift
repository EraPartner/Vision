import Foundation
import VisionNativeCore

/// The "accessed at" field shows the stored instant as local wall-clock time, like the web
/// app's `isoToDateTimeLocal` (ADR-264). Showing the UTC slice as local moved the instant by
/// the UTC offset on every edit.
enum ResearchDossierDateDisplay {
    /// `isoToDateTimeLocal`: "YYYY-MM-DDTHH:mm" in `timeZone`; empty for a missing or
    /// malformed value.
    static func localText(_ value: String?, timeZone: TimeZone = .current) -> String {
        guard let value, !value.isEmpty, let instant = VisionFormat.parseTimestamp(value, timeZone: timeZone) else {
            return ""
        }
        return localValue(instant, timeZone: timeZone)
    }
    static func localDate(_ value: String?, timeZone: TimeZone = .current) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        return VisionFormat.parseTimestamp(value, timeZone: timeZone)
    }
    static func localValue(_ date: Date, timeZone: TimeZone = .current) -> String {
        formatter(timeZone).string(from: date)
    }
    private static func formatter(_ timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
        formatter.isLenient = false
        return formatter
    }
}
