import Foundation

/// The route of the Planned page and its one URL parameter.
public enum PlannedPaymentsRoute {
    public static let path = "/planned"
    /// `show_all`: `true` includes paused payments; anything else, or no value, does not.
    public static let showAllParameter = "show_all"

    /// `booleanSearchParamCodec.parse`.
    public static func showAll(in route: NativeRoute) -> Bool {
        route.value(showAllParameter) == "true"
    }

    /// `booleanSearchParamCodec.serialize`: `true` is written, `false` deletes the parameter.
    public static func showAllValue(_ showAll: Bool) -> String? {
        showAll ? "true" : nil
    }
}

/// The recurrence vocabulary of `PlannedPayment.frequency`, with the view-model-only
/// `custom` for "every N days".
public enum PlannedFrequency: String, CaseIterable, Sendable {
    case daily
    case weekly
    case biweekly
    case monthly
    case quarterly
    case yearly
    case custom

    /// `FREQUENCY_LABEL_KEYS` of PlannedPaymentsTable.
    public var labelKey: String { "plannedPage.freq.\(rawValue)" }

    /// The multiplier of `monthlyMultiplier` in plannedCurrencyTotals.ts.
    func monthlyMultiplier(customIntervalDays: Int?) -> Decimal {
        switch self {
        case .daily: return 30
        case .weekly: return Decimal(string: "4.33") ?? 4
        case .biweekly: return Decimal(string: "2.17") ?? 2
        case .monthly: return 1
        case .quarterly: return Decimal(1) / Decimal(3)
        case .yearly: return Decimal(1) / Decimal(12)
        case .custom:
            guard let days = customIntervalDays, days != 0 else { return 1 }
            return Decimal(30) / Decimal(days)
        }
    }
}

/// `PlannedPayment` of apps/frontend/src/lib/plannedPaymentMapper.ts (`mapFromAPI`): the row
/// the Planned page shows, with the wire row kept for the planned-payment sheet.
public struct PlannedPayment: Equatable, Sendable, Identifiable {
    public let id: Int
    /// `memo || recipient_name || "Unnamed payment"`.
    public let name: String
    /// Signed: money out is negative.
    public let amount: Decimal
    /// `currency || defaultCurrency`.
    public let currency: String
    /// `planned_date` without a time part.
    public let dueDate: String
    public let isRecurring: Bool
    /// `nil` unless recurring.
    public let frequency: PlannedFrequency?
    public let customIntervalDays: Int?
    public let isLoan: Bool
    public let loanTermMonths: Int?
    public let recipient: String?
    public let category: String?
    public let url: String?
    public let isExecuted: Bool
    public let lastExecutedDate: String?
    public let executedTransactionId: Int?
    public let executionCount: Int
    public let executions: [OpenAPI.PlannedTransactionExecution]
    public let isActive: Bool
    public let wire: OpenAPI.PlannedTransaction

    public init(_ wire: OpenAPI.PlannedTransaction, defaultCurrency: String) {
        self.wire = wire
        id = wire.id
        name = Self.nonEmpty(wire.memo) ?? Self.nonEmpty(wire.recipientName) ?? "Unnamed payment"
        amount = wire.amount
        currency = Self.nonEmpty(wire.currency) ?? defaultCurrency
        let date = wire.plannedDate
        dueDate = date.split(separator: "T", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? date
        isRecurring = wire.isRecurring
        let recurrence = Self.recurrence(wire.recurrencePattern)
        frequency = wire.isRecurring ? recurrence.frequency : nil
        customIntervalDays = recurrence.customDays
        isLoan = wire.isLoan ?? false
        loanTermMonths = wire.loanTermMonths
        recipient = wire.recipientName
        category = wire.categoryName
        url = wire.url
        isExecuted = wire.isExecuted
        lastExecutedDate = wire.lastExecutedDate
        executedTransactionId = wire.executedTransactionId
        executionCount = wire.executionCount
        executions = wire.executions ?? []
        isActive = wire.isActive
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        return text
    }

    /// `recurrence_pattern` to a frequency: the six names (any case), else the first run of
    /// digits as a custom interval, else monthly.
    static func recurrence(_ pattern: String?) -> (frequency: PlannedFrequency, customDays: Int?) {
        guard let pattern, !pattern.isEmpty else { return (.monthly, nil) }
        let lowered = pattern.lowercased()
        if let named = PlannedFrequency(rawValue: lowered), named != .custom { return (named, nil) }
        var digits = ""
        for scalar in lowered.unicodeScalars {
            if (48...57).contains(scalar.value) {
                digits.unicodeScalars.append(scalar)
            } else if !digits.isEmpty {
                break
            }
        }
        guard !digits.isEmpty else { return (.monthly, nil) }
        return (.custom, Int(digits))
    }

    // MARK: Cells

    /// The Recurrence column's first line: the loan term, the frequency or One-time.
    public func recurrenceText(_ strings: any Localizing) -> String {
        if isLoan, let months = loanTermMonths, months != 0 {
            return strings.tc("plannedPage.loanTerm", months)
        }
        guard isRecurring else { return strings.t("plannedPage.oneTime") }
        let shown = frequency ?? .monthly
        if shown == .custom, let days = customIntervalDays, days != 0 {
            return strings.t("plannedPage.everyNDays", ["n": String(days)])
        }
        return strings.t(shown.labelKey)
    }

    /// Loans and recurring rows show a repeat icon and, once paid, "Paid {n} times".
    public var showsRepeat: Bool {
        (isLoan && (loanTermMonths ?? 0) != 0) || isRecurring
    }

    /// `plannedPage.executedCount`, under a loan or recurring row that has been paid.
    public func executedText(_ strings: any Localizing) -> String? {
        guard showsRepeat, executionCount > 0 else { return nil }
        return strings.t("plannedPage.executedCount", ["n": String(executionCount)])
    }

    /// The name is struck through while paused or paid.
    public var isStruckThrough: Bool { !isActive || isExecuted }

    /// `safeHref(row.url)`.
    public var safeURL: URL? { PlannedLinks.safeURL(url) }

    /// `/transactions?transaction_id={id}` of the Paid badge, when the row is linked.
    public var linkedTransactionRoute: String? {
        executedTransactionId.map(PlannedLinks.transactionRoute)
    }

    /// The raw field under a `VirtualDataTable` column key.
    public func rawValue(_ key: String) -> TableRawValue {
        switch key {
        case PlannedColumn.payment.rawValue: return .text(name)
        case PlannedColumn.amount.rawValue: return .number(amount)
        case PlannedColumn.dueDate.rawValue: return .text(dueDate)
        case PlannedColumn.recurrence.rawValue: return .bool(isRecurring)
        case PlannedColumn.category.rawValue: return category.map { TableRawValue.text($0) } ?? TableRawValue.none
        case PlannedColumn.status.rawValue: return .bool(isExecuted)
        default: return .none
        }
    }
}

/// The columns of `PlannedPaymentsTable`, by their row key.
public enum PlannedColumn: String, CaseIterable, Sendable {
    case payment = "name"
    case amount
    case dueDate = "due_date"
    case recurrence = "is_recurring"
    case category
    /// Mark as paid, or the Paid badge (no header).
    case status = "is_executed"
    /// The row menu (no header).
    case actions

    /// The five titled columns: sortable and filterable.
    public static let titled: [PlannedColumn] = [.payment, .amount, .dueDate, .recurrence, .category]

    public var headerKey: String? {
        switch self {
        case .payment: return "plannedPage.col.payment"
        case .amount: return "plannedPage.col.amount"
        case .dueDate: return "plannedPage.col.dueDate"
        case .recurrence: return "plannedPage.col.recurrence"
        case .category: return "plannedPage.col.category"
        case .status, .actions: return nil
        }
    }
}

public enum PlannedLinks {
    /// `safeHref`: a trimmed `http(s)` URL (a protocol-relative one gets `https:`), else `nil`.
    public static func safeURL(_ raw: String?) -> URL? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidate = trimmed.hasPrefix("//") ? "https:\(trimmed)" : trimmed
        guard let url = URL(string: candidate), let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https", url.host != nil
        else { return nil }
        return url
    }

    /// The transactions page filtered to one transaction.
    public static func transactionRoute(_ id: Int) -> String {
        "/transactions?transaction_id=\(id)"
    }
}

// MARK: Due dates

/// `PlannedDueDate` of plannedDueDate.ts.
public enum PlannedDueDate: Equatable, Sendable {
    case missing
    case invalid
    /// The local midnight of the calendar day.
    case date(Date)

    /// `parsePlannedDueDate`: the part before `T`, split on `-` into numbers (JavaScript
    /// `Number`, so an empty part is 0), then `new Date(year, month - 1, day)`, whose month
    /// and day overflow into the next ones.
    public static func parse(_ text: String?, calendar: Calendar) -> PlannedDueDate {
        guard let text, !text.isEmpty else { return .missing }
        let datePart = text.split(separator: "T", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        let pieces = datePart.split(separator: "-", omittingEmptySubsequences: false)
        guard pieces.count >= 3, let year = jsNumber(pieces[0]), let month = jsNumber(pieces[1]),
            let day = jsNumber(pieces[2])
        else { return .invalid }
        guard let date = PlannedDates.localDate(year: year, month: month, day: day, calendar: calendar) else {
            return .invalid
        }
        return .date(date)
    }

    /// `Number(text)` truncated like the `Date` constructor; `nil` for `NaN` and infinities.
    static func jsNumber(_ text: Substring) -> Int? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }
        guard let value = Double(trimmed), value.isFinite, abs(value) < 1e9 else { return nil }
        return Int(value.rounded(.towardZero))
    }
}

/// `PlannedDueBadge`: what the Due date column says.
public enum PlannedDueState: Equatable, Sendable {
    case noDate
    case invalid
    case today
    case overdue
    case tomorrow
    /// Two to seven days ahead.
    case inDays(Int)
    /// Further ahead: the date in the app format.
    case date(PlannedDay)

    public init(dueDate: String?, today: Date, calendar: Calendar) {
        switch PlannedDueDate.parse(dueDate, calendar: calendar) {
        case .missing:
            self = .noDate
        case .invalid:
            self = .invalid
        case .date(let date):
            let days = PlannedDates.calendarDays(from: today, to: date, calendar: calendar)
            if days == 0 {
                self = .today
            } else if days < 0 {
                self = .overdue
            } else if days == 1 {
                self = .tomorrow
            } else if days <= 7 {
                self = .inDays(days)
            } else {
                self = .date(PlannedDates.day(date, calendar: calendar))
            }
        }
    }

    public func text(_ strings: any Localizing, format: AppDateFormat) -> String {
        switch self {
        case .noDate: return strings.t("plannedPage.due.noDate")
        case .invalid: return strings.t("plannedPage.due.invalid")
        case .today: return strings.t("plannedPage.due.today")
        case .overdue: return strings.t("plannedPage.due.overdue")
        case .tomorrow: return strings.t("plannedPage.due.tomorrow")
        case .inDays(let days): return strings.t("plannedPage.due.inDays", ["n": String(days)])
        case .date(let day):
            return day.text(format: format)
        }
    }
}

/// Local calendar-day arithmetic in the web app's Gregorian calendar and local time zone.
public enum PlannedDates {
    /// The calendar the page's `Date` arithmetic uses.
    public static var local: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        return calendar
    }

    /// `new Date(year, month - 1, day)`: overflowing months and days roll over.
    static func localDate(year: Int, month: Int, day: Int, calendar: Calendar) -> Date? {
        guard let january = calendar.date(from: DateComponents(year: year, month: 1, day: 1)),
            let monthStart = calendar.date(byAdding: .month, value: month - 1, to: january)
        else { return nil }
        return calendar.date(byAdding: .day, value: day - 1, to: monthStart)
    }

    /// `differenceInCalendarDays(later, earlier)` between the local days of two instants.
    public static func calendarDays(from earlier: Date, to later: Date, calendar: Calendar) -> Int {
        let start = calendar.startOfDay(for: earlier)
        let end = calendar.startOfDay(for: later)
        return calendar.dateComponents([.day], from: start, to: end).day ?? 0
    }

    /// `toYmd` parts of a local day.
    static func day(_ date: Date, calendar: Calendar) -> PlannedDay {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return PlannedDay(year: parts.year ?? 1970, month: parts.month ?? 1, day: parts.day ?? 1)
    }
}

/// A calendar day.
public struct PlannedDay: Equatable, Sendable {
    public let year: Int
    public let month: Int
    public let day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// `formatDateStringWithAppSettings(toYmd(date), format)`.
    public func text(format: AppDateFormat) -> String {
        VisionFormat.appDate(year: year, month: month, day: day, format: format)
    }
}

// MARK: Currency

/// `useCurrencyConverter(target).convertToTargetIfAvailable`: the stored ECB rates with EUR at 1.
/// A currency without a stored rate is unavailable, never converted at a built-in constant (ADR-216).
public struct PlannedCurrencyConverter: Equatable, Sendable {
    public let ratesToEur: [String: Decimal]
    public let target: String

    public init(rates: OpenAPI.ExchangeRates?, target: String) {
        var table: [String: Decimal] = ["EUR": 1]
        for rate in rates?.rates ?? [] { table[rate.currency] = rate.rateToEur }
        ratesToEur = table
        self.target = target
    }

    /// `nil` when either currency has no rate (or a zero one).
    public func convert(_ amount: Decimal, from currency: String?) -> Decimal? {
        let from = (currency ?? "EUR").uppercased()
        let to = target.uppercased()
        if from == to { return amount }
        guard let rateFrom = ratesToEur[from], !rateFrom.isZero, let rateTo = ratesToEur[to], !rateTo.isZero else {
            return nil
        }
        return amount * rateFrom / rateTo
    }
}

/// `ConvertedTotal`: the sum in the target currency and the rows left out for want of a rate.
public struct PlannedConvertedTotal: Equatable, Sendable {
    public let total: Decimal
    public let unavailableCount: Int

    public init(total: Decimal, unavailableCount: Int) {
        self.total = total
        self.unavailableCount = unavailableCount
    }
}

/// plannedCurrencyTotals.ts.
public enum PlannedTotals {
    /// `sumConvertedAmounts`.
    public static func sum(
        _ payments: [PlannedPayment], converter: PlannedCurrencyConverter,
        multiplier: (PlannedPayment) -> Decimal = { _ in 1 }
    ) -> PlannedConvertedTotal {
        var total = Decimal(0)
        var unavailable = 0
        for payment in payments {
            guard let converted = converter.convert(payment.amount, from: payment.currency) else {
                unavailable += 1
                continue
            }
            total += converted * multiplier(payment)
        }
        return PlannedConvertedTotal(total: total, unavailableCount: unavailable)
    }

    /// `sumConvertedMonthlyAmounts`: the signed monthly impact of the active recurring rows.
    public static func monthly(_ payments: [PlannedPayment], converter: PlannedCurrencyConverter)
        -> PlannedConvertedTotal
    {
        sum(payments.filter { $0.isActive && $0.isRecurring }, converter: converter) { payment in
            (payment.frequency ?? .monthly).monthlyMultiplier(customIntervalDays: payment.customIntervalDays)
        }
    }
}

// MARK: Next 7 days

/// `DayBucket` of nextSevenDays.ts: one tile of the strip.
public struct PlannedDayBucket: Equatable, Sendable, Identifiable {
    /// 0 is today, 7 is a week ahead.
    public let offset: Int
    public let date: Date
    public let day: Int
    /// Largest outflow first.
    public let items: [PlannedPayment]

    public var id: Int { offset }
    public var isToday: Bool { offset == 0 }
    /// The two items a tile shows.
    public var shown: [PlannedPayment] { Array(items.prefix(2)) }
    /// The `+{n} more` count.
    public var overflow: Int { items.count - shown.count }
}

/// `NextSevenDaysStrip`'s figures.
public struct PlannedStrip: Equatable, Sendable {
    /// `WINDOW_DAYS`: today and the seven days after it.
    public static let windowDays = 8

    public let buckets: [PlannedDayBucket]
    public let dueCount: Int
    /// The window's signed total in the default currency.
    public let windowTotal: PlannedConvertedTotal
    /// The `plannedPage.next7.range` ends.
    public let from: PlannedDay
    public let to: PlannedDay

    /// `bucketNextSevenDays`: active rows with a readable due date between today and today+7.
    public init(payments: [PlannedPayment], today: Date, calendar: Calendar, converter: PlannedCurrencyConverter) {
        let start = calendar.startOfDay(for: today)
        var grouped = Array(repeating: [PlannedPayment](), count: Self.windowDays)
        for payment in payments where payment.isActive {
            guard case .date(let due) = PlannedDueDate.parse(payment.dueDate, calendar: calendar) else { continue }
            let days = PlannedDates.calendarDays(from: start, to: due, calendar: calendar)
            guard days >= 0, days < Self.windowDays else { continue }
            grouped[days].append(payment)
        }
        var buckets: [PlannedDayBucket] = []
        for offset in 0..<Self.windowDays {
            let date = calendar.date(byAdding: .day, value: offset, to: start) ?? start
            let sorted = Array(grouped[offset].enumerated()).sorted { left, right in
                if left.element.amount == right.element.amount { return left.offset < right.offset }
                return left.element.amount < right.element.amount
            }
            .map { $0.element }
            buckets.append(
                PlannedDayBucket(
                    offset: offset, date: date, day: PlannedDates.day(date, calendar: calendar).day, items: sorted))
        }
        self.buckets = buckets
        dueCount = buckets.reduce(0) { $0 + $1.items.count }
        windowTotal = PlannedTotals.sum(buckets.flatMap { $0.items }, converter: converter)
        from = PlannedDates.day(buckets.first?.date ?? start, calendar: calendar)
        to = PlannedDates.day(buckets.last?.date ?? start, calendar: calendar)
    }

    /// `plannedPage.next7.range`.
    public func rangeText(_ strings: any Localizing, format: AppDateFormat) -> String {
        strings.t("plannedPage.next7.range", ["from": from.text(format: format), "to": to.text(format: format)])
    }
}
