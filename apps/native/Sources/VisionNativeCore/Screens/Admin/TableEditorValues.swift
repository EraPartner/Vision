import Foundation

/// The value helpers of `TableDataEditorPage` (`display`, `valuesEqual`, the editor's
/// prefill) for the JSON cells of `GET .../rows`. A missing cell is `nil`, JavaScript's
/// `undefined`.
public enum TableCellValue {
    /// `display(value)`: `NULL` for null or a missing cell, objects and arrays as JSON,
    /// everything else as `String(value)`.
    public static func display(_ value: JSONValue?) -> (text: String, isNull: Bool) {
        guard let value, value != .null else { return ("NULL", true) }
        switch value {
        case .object, .array: return (json(value), false)
        default: return (jsString(value), false)
        }
    }

    /// The inline editor's prefill: empty for NULL, objects and arrays as JSON.
    public static func editText(_ value: JSONValue?) -> String {
        guard let value, value != .null else { return "" }
        switch value {
        case .object, .array: return json(value)
        default: return jsString(value)
        }
    }

    /// `valuesEqual(a, b)`: an edit equal to the loaded value is not a change. Objects
    /// compare as JSON text (also against a typed string), anything else as `String()`.
    public static func equal(_ original: JSONValue?, _ edited: JSONValue?) -> Bool {
        let a = original ?? .null
        let b = edited ?? .null
        if a == b { return true }
        if a == .null { return b == .null }
        switch a {
        case .object, .array:
            switch b {
            case .object, .array, .null: return json(a) == json(b)
            default: return json(a) == jsString(b)
            }
        default:
            return jsString(a) == jsString(b)
        }
    }

    /// `udtName === "bool" || dataType === "boolean"`.
    public static func isBoolean(_ column: OpenAPI.DbEditorColumn) -> Bool {
        column.udtName == "bool" || column.dataType == "boolean"
    }

    /// `JSON.stringify(value)`, with object keys sorted. `JSONValue.object` is a dictionary, so
    /// the decoded key order is already lost; sorting keeps the text stable for `equal` and the
    /// row keys. Known limitation: an object cell's editor prefill, and so an edited value sent
    /// back, lists its keys sorted, not in the order the server returned them.
    public static func json(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// `String(value)` for a JSON value.
    public static func jsString(_ value: JSONValue) -> String {
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .int(let number): return String(number)
        case .double(let number): return jsNumber(number)
        case .string(let text): return text
        case .array(let items):
            return items.map { item in item == .null ? "" : jsString(item) }.joined(separator: ",")
        case .object: return "[object Object]"
        }
    }

    /// `String(number)`: integral values without a fraction, `NaN` and `Infinity` spelled out.
    static func jsNumber(_ number: Double) -> String {
        if number.isNaN { return "NaN" }
        if number.isInfinite { return number < 0 ? "-Infinity" : "Infinity" }
        if number == number.rounded(), abs(number) < 1e21 {
            return NSDecimalNumber(value: number).stringValue
        }
        return "\(number)"
    }
}

/// The admin pages' date text of a PostgreSQL `timestamptz::text` value (the
/// `last_autovacuum` and `last_autoanalyze` columns): `formatDateTimeWithAppSettings(new Date(ts))`.
public enum PostgresTimestamp {
    /// Parses `2026-04-24 10:15:32.123456+00` (also with `T`, `Z` or a `+hh:mm` offset).
    public static func parse(_ text: String) -> Date? {
        let pattern =
            #"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
        else { return nil }
        func group(_ index: Int) -> String? {
            guard let range = Range(match.range(at: index), in: text) else { return nil }
            return String(text[range])
        }
        var components = DateComponents()
        components.year = group(1).flatMap { Int($0) }
        components.month = group(2).flatMap { Int($0) }
        components.day = group(3).flatMap { Int($0) }
        components.hour = group(4).flatMap { Int($0) }
        components.minute = group(5).flatMap { Int($0) }
        components.second = group(6).flatMap { Int($0) }
        var calendar = Calendar(identifier: .gregorian)
        let zone = group(8)
        if let zone, zone != "Z" {
            let sign = zone.hasPrefix("-") ? -1 : 1
            let digits = zone.dropFirst().replacingOccurrences(of: ":", with: "")
            let hours = Int(digits.prefix(2)) ?? 0
            let minutes = digits.count > 2 ? Int(digits.suffix(2)) ?? 0 : 0
            guard let offset = TimeZone(secondsFromGMT: sign * (hours * 3600 + minutes * 60)) else { return nil }
            calendar.timeZone = offset
        } else if zone == "Z" {
            calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        } else {
            // Without a zone, `new Date(...)` reads local time.
            calendar.timeZone = .current
        }
        guard let whole = calendar.date(from: components) else { return nil }
        let fraction = group(7).flatMap { Double("0.\($0)") } ?? 0
        return whole.addingTimeInterval(fraction)
    }

    /// The app date format and the locale's two-digit time, `—` for a missing value, and the
    /// text itself when it is not a timestamp.
    public static func appDateTime(
        _ text: String?, settings: NativeAppSettings, timeZone: TimeZone = .current
    ) -> String {
        guard let text, !text.isEmpty else { return "—" }
        guard let instant = parse(text) else { return text }
        let date = VisionFormat.appDate(instant, format: settings.dateFormat, timeZone: timeZone)
        let time = VisionFormat.time(instant, locale: settings.numberFormat.locale, timeZone: timeZone)
        return "\(date) \(time)"
    }
}
