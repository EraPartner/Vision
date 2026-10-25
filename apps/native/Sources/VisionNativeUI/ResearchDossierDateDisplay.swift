import Foundation

/// The browser slices an ISO timestamp before binding datetime-local; edits then interpret
/// that prefix in the host timezone. Keep that existing behavior rather than shifting it.
enum ResearchDossierDateDisplay {
    static func localPrefix(_ value: String?) -> String { String((value ?? "").prefix(16)) }
    static func localDate(_ value: String?, timeZone: TimeZone = .current) -> Date? {
        formatter(timeZone).date(from: localPrefix(value))
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
