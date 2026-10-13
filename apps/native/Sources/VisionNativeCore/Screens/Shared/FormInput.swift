import Foundation

/// The web app's number-field parsing and formatting (apps/frontend/src/utils/currency.ts
/// and lib/decimal.ts) in the four app number formats.
public enum LocaleNumber {
    /// `parseLocaleNumber`: `nil` where the web gets `NaN`. Accepts a sign or parentheses, one
    /// currency symbol before or after, and the format's grouping and decimal separators.
    public static func parse(_ input: String, format: NumberFormat) -> Decimal? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        var negative = false
        if text.hasPrefix("(") && text.hasSuffix(")") && text.count >= 2 {
            negative = true
            text = String(text.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty || text.hasPrefix("+") || text.hasPrefix("-") { return nil }
        } else if text.contains("(") || text.contains(")") {
            return nil
        }
        if text.hasPrefix("-") {
            negative = true
            text = String(text.dropFirst()).trimmingLeadingWhitespace()
        } else if text.hasPrefix("+") {
            text = String(text.dropFirst()).trimmingLeadingWhitespace()
        }
        let symbols: Set<Character> = ["$", "€", "£", "¥", "₹"]
        var hadPrefix = false
        if let first = text.first, symbols.contains(first) {
            hadPrefix = true
            text = String(text.dropFirst()).trimmingLeadingWhitespace()
        }
        if let last = text.last, symbols.contains(last) {
            if hadPrefix { return nil }
            text = String(text.dropLast()).trimmingTrailingWhitespace()
        }
        guard !text.isEmpty, !text.contains(where: { $0.isWhitespace }) else { return nil }
        guard text.range(of: pattern(format), options: .regularExpression) != nil else { return nil }
        let decimalSeparator: Character = format == .eu ? "," : "."
        let grouping: Set<Character>
        switch format {
        case .eu: grouping = ["."]
        case .us, .in: grouping = [","]
        case .ch: grouping = ["'", "’"]
        }
        var normalized = String(text.filter { !grouping.contains($0) })
        if let index = normalized.firstIndex(of: decimalSeparator) {
            normalized.replaceSubrange(index...index, with: ".")
        }
        guard let value = Decimal(string: normalized, locale: Locale(identifier: "en_US_POSIX")) else { return nil }
        return negative ? -value : value
    }

    /// `parseDecimal(value, format)`: the parsed number, or 0 for an empty or invalid entry.
    public static func parseOrZero(_ input: String, format: NumberFormat) -> Decimal {
        parse(input, format: format) ?? 0
    }

    /// `formatEditableNumber`: the plain number with the format's decimal separator (only
    /// the European format writes a comma); empty for no value.
    public static func editable(_ value: Decimal?, format: NumberFormat) -> String {
        guard let value, !value.isNaN else { return "" }
        let plain = VisionFormat.plain(value)
        return format == .eu ? plain.replacingOccurrences(of: ".", with: ",") : plain
    }

    /// `formatNumberPlaceholder`: zero with two decimals in the format's locale.
    public static func placeholder(format: NumberFormat) -> String {
        VisionFormat.decimal(0, fractionDigits: 2, locale: format.locale)
    }

    static func pattern(_ format: NumberFormat) -> String {
        switch format {
        case .eu: return "^(?:\\d+|\\d{1,3}(?:\\.\\d{3})+)(?:,\\d+)?$"
        case .us: return "^(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d+)?$"
        case .ch: return "^(?:\\d+|\\d{1,3}(?:'\\d{3})+|\\d{1,3}(?:’\\d{3})+)(?:\\.\\d+)?$"
        case .in: return "^(?:\\d+|\\d{1,2}(?:,\\d{2})*,\\d{3})(?:\\.\\d+)?$"
        }
    }
}

/// JavaScript integer parsing for the number inputs of the forms.
public enum JSInteger {
    /// `parseInt(text, 10)`: leading whitespace, an optional sign, then the run of ASCII
    /// digits; `nil` (`NaN`) when there are none.
    public static func parse(_ text: String) -> Int? {
        var rest = Substring(text.trimmingLeadingWhitespace())
        var negative = false
        if rest.first == "-" || rest.first == "+" {
            negative = rest.first == "-"
            rest = rest.dropFirst()
        }
        let digits = rest.prefix { $0.isASCII && $0.isNumber }
        guard !digits.isEmpty else { return nil }
        // Beyond Int's range the web keeps a float; no field here accepts such a value.
        guard let value = Int(digits) else { return nil }
        return negative ? -value : value
    }

    /// `Number(text)` for a tolerance field: `nil` for an empty, non-numeric or infinite entry.
    public static func number(_ text: String) -> Decimal? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let value = Double(trimmed), value.isFinite else { return nil }
        return Decimal(string: trimmed, locale: Locale(identifier: "en_US_POSIX")) ?? Decimal(value)
    }
}

/// `slugify` of packages/shared-utils: lowercase, whitespace runs to `-`, only `a-z`, `0-9`
/// and `-` kept, hyphen runs collapsed, no leading or trailing hyphen.
public enum TagSlug {
    public static func slugify(_ input: String) -> String {
        let lowered = input.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        var output = ""
        var lastWasSpace = false
        for character in lowered {
            if character.isWhitespace {
                if !lastWasSpace { output.append("-") }
                lastWasSpace = true
                continue
            }
            lastWasSpace = false
            if character.isASCII && (character.isLetter || character.isNumber || character == "-") {
                output.append(character)
            }
        }
        var collapsed = ""
        for character in output where !(character == "-" && collapsed.last == "-") {
            collapsed.append(character)
        }
        if collapsed.hasPrefix("-") { collapsed.removeFirst() }
        if collapsed.hasSuffix("-") { collapsed.removeLast() }
        return collapsed
    }
}

extension PlannedDay {
    /// `toYmd`.
    public var ymd: String {
        func pad(_ value: Int, _ width: Int) -> String {
            let text = String(value)
            return text.count >= width ? text : String(repeating: "0", count: width - text.count) + text
        }
        return "\(pad(year, 4))-\(pad(month, 2))-\(pad(day, 2))"
    }

    /// `parseLocalDateFromYmd`: the date part of `YYYY-MM-DD[T…]`, rolled over like
    /// `new Date(y, m - 1, d)`; `nil` when it does not read as three numbers.
    public init?(ymd text: String?, calendar: Calendar) {
        guard case .date(let date) = PlannedDueDate.parse(text, calendar: calendar) else { return nil }
        self = PlannedDates.day(date, calendar: calendar)
    }

    /// The local day of an instant.
    public init(_ date: Date, calendar: Calendar) {
        self = PlannedDates.day(date, calendar: calendar)
    }

    /// The local midnight of the day.
    public func date(calendar: Calendar) -> Date? {
        calendar.date(from: DateComponents(year: year, month: month, day: day))
    }

    /// The day `days` later (or earlier when negative), rolling over months and years.
    public func adding(days: Int, calendar: Calendar) -> PlannedDay {
        guard let start = date(calendar: calendar),
            let moved = calendar.date(byAdding: .day, value: days, to: start)
        else { return self }
        return PlannedDay(moved, calendar: calendar)
    }
}

/// The typed-date input of `DatePicker` (`parseAppDateInput`): exactly the app date format,
/// a real calendar day, nothing else.
public enum AppDateInput {
    /// What committing the typed field does.
    public enum Commit: Equatable, Sendable {
        /// Nothing to change: the text shows the current day, or a required field was emptied.
        case keep
        /// An optional field was emptied: the day is cleared.
        case clear
        case set(PlannedDay)
        /// `datePicker.invalidFormat`.
        case invalid
    }

    /// Return or leaving the typed field: an empty draft is never invalid; it clears an
    /// optional field and leaves a required one as it was.
    public static func commit(
        _ draft: String, current: PlannedDay?, format: AppDateFormat, allowClear: Bool
    ) -> Commit {
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return allowClear && current != nil ? .clear : .keep
        }
        if let current, draft == current.text(format: format) { return .keep }
        guard let parsed = parse(draft, format: format) else { return .invalid }
        return .set(parsed)
    }

    public static func parse(_ input: String, format: AppDateFormat) -> PlannedDay? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let pattern: String
        let order: (year: Int, month: Int, day: Int)
        switch format {
        case .dayMonthYearSlash: pattern = "^(\\d{2})/(\\d{2})/(\\d{4})$"; order = (3, 2, 1)
        case .monthDayYearSlash: pattern = "^(\\d{2})/(\\d{2})/(\\d{4})$"; order = (3, 1, 2)
        case .isoDate: pattern = "^(\\d{4})-(\\d{2})-(\\d{2})$"; order = (1, 2, 3)
        case .dayMonthYearDot: pattern = "^(\\d{2})\\.(\\d{2})\\.(\\d{4})$"; order = (3, 2, 1)
        case .dayMonthYearDash: pattern = "^(\\d{2})-(\\d{2})-(\\d{4})$"; order = (3, 2, 1)
        }
        guard let regex = try? NSRegularExpression(pattern: pattern),
            let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
            match.numberOfRanges == 4
        else { return nil }
        func group(_ index: Int) -> Int? {
            guard let range = Range(match.range(at: index), in: text) else { return nil }
            return Int(text[range])
        }
        guard let year = group(order.year), let month = group(order.month), let day = group(order.day),
            year >= 1, (1...12).contains(month), day >= 1, day <= daysIn(month: month, year: year)
        else { return nil }
        return PlannedDay(year: year, month: month, day: day)
    }

    static func daysIn(month: Int, year: Int) -> Int {
        switch month {
        case 2:
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
            return leap ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }
}

extension String {
    fileprivate func trimmingLeadingWhitespace() -> String {
        String(drop { $0.isWhitespace })
    }

    fileprivate func trimmingTrailingWhitespace() -> String {
        var copy = self
        while let last = copy.last, last.isWhitespace { copy.removeLast() }
        return copy
    }
}
