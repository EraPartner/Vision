import VisionNativeCore

/// The typed day of a fixture written as `YYYY-MM-DD`. Production code takes days from decoded
/// models or `CalendarDay(_:)`; a fixture typo should stop the test, so this traps on a bad day.
func fixtureDay(_ text: String) -> CalendarDay {
    guard let day = CalendarDay(text) else {
        preconditionFailure("\"\(text)\" is not a calendar day (YYYY-MM-DD)")
    }
    return day
}

/// The typed timestamp of a fixture written as ISO 8601 with a zone, such as
/// `2026-10-09T08:05:00.000Z`. Traps on a bad timestamp, like `fixtureDay`.
func fixtureInstant(_ text: String) -> Instant {
    guard let instant = Instant(text) else {
        preconditionFailure("\"\(text)\" is not an ISO 8601 timestamp with a zone")
    }
    return instant
}

extension OpenAPI.SettingBaseline {
    /// A baseline written as the JSON of the wire (`{ exists: false }`, `{ exists: true, value }`).
    /// Traps on JSON that is not a baseline.
    static func wire(_ json: JSONValue) -> OpenAPI.SettingBaseline {
        do {
            return try OpenAPI.SettingBaseline(json: json)
        } catch {
            preconditionFailure("not a setting baseline: \(error)")
        }
    }
}

/// The currency code of a fixture written as three capitals, such as `EUR`. Traps on a bad code,
/// like `fixtureDay`.
func fixtureCurrency(_ text: String) -> CurrencyCode {
    guard let code = CurrencyCode(rawValue: text) else {
        preconditionFailure("\"\(text)\" is not an ISO 4217 currency code")
    }
    return code
}
