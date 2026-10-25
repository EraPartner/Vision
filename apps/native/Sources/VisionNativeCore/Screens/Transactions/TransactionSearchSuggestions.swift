import Foundation

/// The search field's suggestion dropdown (`TransactionSearchSuggestions`): quick filters that
/// merge URL parameters into the filter set, and the four sub-forms (Amount equals, Amount
/// range, Year, Date range).
public struct TransactionSearchSuggestions: Equatable, Sendable {
    public enum Mode: Equatable, Sendable {
        case list
        case amountExact
        case amountRange
        case year
        case dateRange
    }

    public var mode: Mode = .list
    public var amountA = ""
    public var amountB = ""
    public var yearInput: String
    public var dateStart: PlannedDay?
    public var dateEnd: PlannedDay?
    public let thisYear: Int

    public init(thisYear: Int) {
        self.thisYear = thisYear
        yearInput = String(thisYear)
    }

    public var lastYear: Int { thisYear - 1 }

    /// All income / All expenses.
    public static func type(_ type: TransactionTypeFilter) -> [QuickFilterParameter] {
        [QuickFilterParameter("transaction_type", type.rawValue)]
    }

    /// `yearRange`: 1 January to 31 December.
    public static func yearRange(_ year: Int) -> [QuickFilterParameter] {
        let padded = String(format: "%04d", year)
        return [QuickFilterParameter("start_date", "\(padded)-01-01"), QuickFilterParameter("end_date", "\(padded)-12-31")]
    }

    /// `parseSigned`: a leading `+` or `-` makes the amount sign-aware; a bare number matches
    /// the magnitude. `nil` for an empty or unreadable entry.
    static func parseSigned(_ raw: String, format: NumberFormat) -> (value: Decimal, signed: Bool)? {
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        let signed = text.hasPrefix("+") || text.hasPrefix("-")
        let body = text.hasPrefix("+") ? String(text.dropFirst()) : text
        guard let value = LocaleNumber.parse(body, format: format) else { return nil }
        return (value, signed)
    }

    private var isRange: Bool { mode == .amountRange }

    private func invalidA(_ format: NumberFormat) -> Bool {
        !amountA.trimmingCharacters(in: .whitespaces).isEmpty && Self.parseSigned(amountA, format: format) == nil
    }

    private func invalidB(_ format: NumberFormat) -> Bool {
        isRange && !amountB.trimmingCharacters(in: .whitespaces).isEmpty
            && Self.parseSigned(amountB, format: format) == nil
    }

    /// `search.suggest.amount.invalid` shows.
    public func amountInvalid(format: NumberFormat) -> Bool {
        invalidA(format) || invalidB(format)
    }

    /// Apply of an amount form: `nil` (disabled) until valid. Equals is a zero-width range;
    /// a range is put in order; `amount_signed=true` when a sign was typed.
    public func amountParameters(format: NumberFormat) -> [QuickFilterParameter]? {
        guard !amountInvalid(format: format) else { return nil }
        let first = Self.parseSigned(amountA, format: format)
        let second = isRange ? Self.parseSigned(amountB, format: format) : nil
        guard isRange ? (first != nil || second != nil) : first != nil else { return nil }
        let signed = (first?.signed ?? false) || (second?.signed ?? false)
        func converted(_ parsed: (value: Decimal, signed: Bool)?) -> Decimal? {
            guard let parsed else { return nil }
            return signed || parsed.value >= 0 ? parsed.value : -parsed.value
        }
        let signedParameter = QuickFilterParameter("amount_signed", signed ? "true" : nil)
        if isRange {
            var low = converted(first)
            var high = converted(second)
            if let lower = low, let higher = high, lower > higher { (low, high) = (higher, lower) }
            return [
                QuickFilterParameter("amount_min", low.map(VisionFormat.plain)),
                QuickFilterParameter("amount_max", high.map(VisionFormat.plain)), signedParameter,
            ]
        }
        guard let value = converted(first) else { return nil }
        let text = VisionFormat.plain(value)
        return [QuickFilterParameter("amount_min", text), QuickFilterParameter("amount_max", text), signedParameter]
    }

    /// Four digits from 1900 to 2999.
    public var yearValue: Int? {
        let text = yearInput.trimmingCharacters(in: .whitespaces)
        guard text.count == 4, text.allSatisfy({ $0.isASCII && $0.isNumber }), let year = Int(text),
            (1900...2999).contains(year)
        else { return nil }
        return year
    }

    /// `search.suggest.date.invalidOrder` shows.
    public var datesReversed: Bool {
        guard let dateStart, let dateEnd else { return false }
        return dateStart.ymd > dateEnd.ymd
    }

    /// Apply of the date range: either side, in order.
    public var dateParameters: [QuickFilterParameter]? {
        guard dateStart != nil || dateEnd != nil, !datesReversed else { return nil }
        return [QuickFilterParameter("start_date", dateStart?.ymd), QuickFilterParameter("end_date", dateEnd?.ymd)]
    }
}
