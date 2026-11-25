import Foundation

/// `lib/calculations/recurrence.ts`: the planned-payment pattern grammar and its steppers.
/// The grammar lives in `parseStep`; `nextOccurrenceYmd` is the string-space stepper
/// `executePlanned` advances with, `expandOccurrences` the horizon walk
/// `plannedTotalsService` counts with, and `monthlyOccurrenceFactor` the monthly weight of
/// a cadence.
enum Recurrence {
    struct Step: Equatable, Sendable {
        enum Unit: Equatable, Sendable { case day, month }
        let unit: Unit
        /// Whole steps per occurrence (>= 1), `parseInt`'s double.
        let amount: Double
    }

    /// `PLANNED_RECURRENCE_PATTERNS`: the named half of the grammar.
    public static let supportedPatterns = [
        "daily", "weekly", "biweekly", "monthly", "quarterly", "yearly",
    ]

    /// The named cadences of the grammar, keyed by their normalized form.
    static let named: [String: Step] = [
        "daily": Step(unit: .day, amount: 1), "weekly": Step(unit: .day, amount: 7),
        "biweekly": Step(unit: .day, amount: 14), "monthly": Step(unit: .month, amount: 1),
        "quarterly": Step(unit: .month, amount: 3), "yearly": Step(unit: .month, amount: 12),
    ]

    /// `parseRecurrenceStep` (exported `__parseRecurrenceStep`): a named cadence or
    /// `every N days`, case- and whitespace-insensitive; a non-string, an empty string and
    /// anything else are nil.
    static func parseStep(_ pattern: JSValue?) -> Step? {
        guard let text = pattern?.stringValue, !text.isEmpty else { return nil }
        let normalized = JavaScriptWhitespace.trim(text.lowercased())
        if let named = Self.named[normalized] { return named }
        // `/^every\s+(\d+)\s+days?$/` over the normalized text: whitespace-runs around the
        // digits, `day` or `days`, and nothing after.
        guard normalized.hasPrefix("every") else { return nil }
        var rest = Substring(normalized.dropFirst(5))
        guard let space = rest.firstIndex(where: { !$0.isJSWhitespace }) else { return nil }
        rest = rest[space...]
        guard let lastDigit = rest.firstIndex(where: { !$0.isASCIIDigit }) else { return nil }
        let digits = rest[..<lastDigit]
        guard !digits.isEmpty else { return nil }
        rest = rest[lastDigit...]
        guard let afterDigits = rest.firstIndex(where: { !$0.isJSWhitespace }) else { return nil }
        let tail = JavaScriptWhitespace.trim(String(rest[afterDigits...]))
        guard ["day", "days"].contains(tail) else { return nil }
        guard let days = JavaScriptInteger.parse(String(digits)), days >= 1 else { return nil }
        return Step(unit: .day, amount: days)
    }

    /// `addMonthsClampedYmd`: `months` added to a `YYYY-MM-DD` string, the day clamped to
    /// the target month's last day (Jan 31 + 1 → Feb 28). Applied one step at a time by the
    /// steppers, so the clamp compounds (Jan 31 → Feb 28 → Mar 28).
    static func addMonthsClamped(_ ymd: String, _ months: Int) throws -> String {
        let parts = try CalendarDays.parts(ymd)
        let firstOfTarget = try CalendarDays.firstOfMonth(ymd, monthOffset: months)
        let firstOfNextTarget = try CalendarDays.firstOfMonth(ymd, monthOffset: months + 1)
        let lastDay = try CalendarDays.adding(-1, to: firstOfNextTarget)
        let day = min(parts.day, Int(String(lastDay.suffix(2))) ?? 1)
        return "\(firstOfTarget.prefix(8))\(String(format: "%02d", day))"
    }

    /// `nextOccurrenceYmd`: the occurrence after `ymd`, or nil for a pattern the grammar
    /// cannot advance.
    static func nextOccurrenceYmd(_ ymd: String, _ pattern: String?) throws -> String? {
        guard let step = parseStep(.string(pattern ?? "")) else { return nil }
        return step.unit == .day
            ? try CalendarDays.adding(exactDays(step.amount), to: ymd)
            : try addMonthsClamped(ymd, Int(step.amount))
    }

    /// `addDaysYmd`'s `Number.isInteger` guard, then a Swift `Int` for the calendar walk; an
    /// amount outside the day grid is the invalid `Date` the TypeScript walks into.
    static func exactDays(_ days: Double) throws -> Int {
        guard days.rounded() == days, let exact = Int(exactly: days) else {
            throw CalendarDays.outOfRange
        }
        return exact
    }

    /// `isValidPattern`.
    static func isValidPattern(_ pattern: JSValue?) -> Bool { parseStep(pattern) != nil }

    /// `fastForwardYmd`: a stale day-stepped anchor jumped a whole number of steps before
    /// `targetYmd`; month steppers and near anchors unchanged.
    static func fastForward(_ ymd: String, _ pattern: String?, _ targetYmd: String) throws -> String {
        guard let step = parseStep(.string(pattern ?? "")), step.unit == .day else { return ymd }
        let deficit = try CalendarDays.difference(from: ymd, to: targetYmd)
        let stepDays = try exactDays(step.amount)
        if deficit <= stepDays { return ymd }
        let hops = deficit / stepDays - 1
        if hops <= 0 { return ymd }
        return try CalendarDays.adding(hops * stepDays, to: ymd)
    }

    /// `monthlyOccurrenceFactor`: how many occurrences of the pattern fall in an average
    /// month (30.4375 days), nil for a pattern the grammar does not recognise.
    static func monthlyOccurrenceFactor(_ pattern: String?) throws -> DecimalJS? {
        guard let step = parseStep(.string(pattern ?? "")) else { return nil }
        let amount = try DecimalJS.from(SQLArguments.javaScriptText(step.amount))
        return step.unit == .month
            ? try DecimalJS.one.dividedBy(amount)
            : try DecimalJS.from("30.4375").dividedBy(amount)
    }

    /// `expandOccurrences` (the `plannedTotalsService` walk): the ordered occurrence dates
    /// of a row on or before `horizonYmd`, inclusive, capped at `maxOccurrences`. The
    /// TypeScript walks `calculateNextDate` on APP_TIMEZONE start-of-day `Date`s; the anchor
    /// and every hop of that walk are the same calendar days this string-space stepper
    /// produces (month steppers clamp identically, one step at a time).
    static func expandOccurrences(
        row: (plannedDate: String, isRecurring: Bool, recurrencePattern: String?),
        horizonYmd: String, maxOccurrences: Int = 500
    ) throws -> [String] {
        let first = row.plannedDate
        guard first <= horizonYmd, (try? CalendarDays.epochDay(first)) != nil else { return [] }
        guard row.isRecurring, let pattern = row.recurrencePattern,
            parseStep(.string(pattern)) != nil
        else { return [first] }
        var occurrences: [String] = []
        var current = first
        var count = 0
        while current <= horizonYmd && count < maxOccurrences {
            occurrences.append(current)
            guard let next = try nextOccurrenceYmd(current, pattern), next > current else { break }
            current = next
            count += 1
        }
        return occurrences
    }
}

extension Character {
    /// JavaScript's `\d`: an ASCII digit, for a single-scalar grapheme.
    var isASCIIDigit: Bool {
        guard let scalar = unicodeScalars.first, unicodeScalars.count == 1 else { return false }
        return (0x30...0x39).contains(scalar.value)
    }

    /// JavaScript's `\s`: the Unicode whitespace a pattern's runs may hold.
    var isJSWhitespace: Bool { unicodeScalars.allSatisfy(JavaScriptWhitespace.contains) }
}
