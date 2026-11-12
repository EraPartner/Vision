import Foundation

/// One daily price: epoch milliseconds and a price in the investment's currency.
struct PricePoint: Equatable, Sendable {
    var timestampMs: Double
    var price: Double

    var jsonValue: JSValue {
        func number(_ value: Double) -> JSValue { value.isFinite ? .number(value) : .string(JavaScriptNumber.text(value)) }
        return .object(JSObject([("timestampMs", number(timestampMs)), ("price", number(price))]))
    }
}

/// The point rules of `services/prices/priceCache.ts`: what counts as a price, one point per
/// UTC calendar day at noon, the range filter and the test for a stale series.
enum PriceHistory {
    static let dayMs = 86_400_000.0

    /// A time value past what a JavaScript `Date` holds; `toISOString` throws there.
    struct OutOfRange: Error, Equatable, Sendable {}

    /// `toNumber(value)`: `Number(value)` when finite. `nil` in is JavaScript's `undefined`.
    static func number(_ value: JSValue?) -> Double? {
        guard let number = value?.javaScriptNumber, number.isFinite else { return nil }
        return number
    }

    /// `isValidPrice(value)`: finite and above zero.
    static func isValid(_ price: Double?) -> Bool { price.map { $0.isFinite && $0 > 0 } ?? false }

    /// `epochMsToUtcYmd(ms)`: the first ten characters of `toISOString()`, which for a year
    /// outside 0000 to 9999 are a sign, six year digits and the month.
    static func dateOnly(_ timestampMs: Double) throws -> String? {
        guard timestampMs.isFinite else { return nil }
        guard abs(timestampMs) <= 8.64e15 else { throw OutOfRange() }
        let days = Int((timestampMs.rounded(.towardZero) / dayMs).rounded(.down))
        let civil = XLSXWorkbook.civil(fromDays: days)
        func pad(_ value: Int, _ width: Int) -> String {
            let digits = String(value)
            return String(repeating: "0", count: max(0, width - digits.count)) + digits
        }
        if (0...9999).contains(civil.year) { return "\(pad(civil.year, 4))-\(pad(civil.month, 2))-\(pad(civil.day, 2))" }
        return "\(civil.year < 0 ? "-" : "+")\(pad(abs(civil.year), 6))-\(pad(civil.month, 2))"
    }

    /// `dateOnlyToTimestampMs(text)`: UTC noon of the day the trimmed text starts with
    /// (`YYYY-MM-DD`, then anything), NaN for anything else. (The TypeScript also takes a `Date`
    /// and other date text through the engine's parser; the price layer passes it day text only.)
    static func noon(_ dateOnly: String) -> Double {
        let units = Array(Array(JavaScriptWhitespace.trim(dateOnly).utf16).prefix(10))
        guard units.count == 10, units[4] == 0x2D, units[7] == 0x2D,
            units.enumerated().allSatisfy({ $0.offset == 4 || $0.offset == 7 || ($0.element >= 0x30 && $0.element <= 0x39) })
        else { return .nan }
        func part(_ range: Range<Int>) -> Int { units[range].reduce(0) { $0 * 10 + Int($1) - 0x30 } }
        let year = part(0..<4)
        let month = part(5..<7)
        let day = part(8..<10)
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        guard (1...12).contains(month), day >= 1, day <= lengths[month - 1] else { return .nan }
        return Double(XLSXWorkbook.days(fromCivil: year, month, day)) * dayMs + 12 * 3_600_000
    }

    /// `a.localeCompare(b)` for day keys: the collation puts `-` before `+` before the digits.
    private static func precedes(_ a: String, _ b: String) -> Bool {
        func rank(_ unit: UInt8) -> Int { unit == 0x2D ? 0 : unit == 0x2B ? 1 : Int(unit) }
        return a.utf8.map(rank).lexicographicallyPrecedes(b.utf8.map(rank))
    }

    /// `normalizeHistoryPoints(points)`: the valid points, one per UTC day (the last one
    /// wins), in date order. Anything that is not an array is no points.
    static func normalize(_ points: JSValue?) throws -> [PricePoint] {
        guard case .array(let raw)? = points else { return [] }
        var order: [String] = []
        var byDate: [String: PricePoint] = [:]
        for point in raw {
            let fields = point.objectValue
            // `Number(undefined)` is NaN: a point without a timestamp is dropped.
            guard let timestamp = fields?["timestampMs"]?.javaScriptNumber, timestamp.isFinite,
                let price = number(fields?["price"]), isValid(price), let day = try dateOnly(timestamp)
            else { continue }
            if byDate[day] == nil { order.append(day) }
            byDate[day] = PricePoint(timestampMs: noon(day), price: price)
        }
        return order.enumerated().sorted { a, b in
            precedes(a.element, b.element) || (!precedes(b.element, a.element) && a.offset < b.offset)
        }.compactMap { byDate[$0.element] }
    }

    static func normalize(_ points: [PricePoint]) throws -> [PricePoint] {
        try normalize(.array(points.map { .object(JSObject([("timestampMs", .number($0.timestampMs)), ("price", .number($0.price))])) }))
    }

    /// A bound as the TypeScript reads it: `Number(value)` when finite.
    private static func bound(_ value: JSValue?) -> Double? { number(value) }

    /// `filterPointsByRange(points, { fromMs, toMs })`.
    static func filter(_ points: [PricePoint], from: JSValue? = nil, to: JSValue? = nil) -> [PricePoint] {
        let from = bound(from)
        let to = bound(to)
        return points.filter { point in
            if let from, point.timestampMs < from { return false }
            if let to, point.timestampMs > to { return false }
            return true
        }
    }

    /// `needsHistoryRefresh(points, { fromMs, toMs })`: no usable points, or the series starts
    /// more than a day after the window or ends more than a day before it.
    static func needsRefresh(_ points: JSValue?, from: JSValue? = nil, to: JSValue? = nil) throws -> Bool {
        let normalized = try normalize(points)
        guard let first = normalized.first?.timestampMs, let last = normalized.last?.timestampMs, first.isFinite,
            last.isFinite
        else { return true }
        if let from = bound(from), first > from + dayMs { return true }
        if let to = bound(to), last < to - dayMs { return true }
        return false
    }

    /// `countChangedPointPrices(before, after)`: positions where both prices are valid and
    /// differ by more than 1e-9.
    static func changedPrices(_ before: JSValue?, _ after: JSValue?) -> Int {
        guard case .array(let before)? = before, case .array(let after)? = after else { return 0 }
        return zip(before, after).filter { old, new in
            guard let a = number(old.objectValue?["price"]), let b = number(new.objectValue?["price"]), isValid(a),
                isValid(b)
            else { return false }
            return abs(a - b) > 1e-9
        }.count
    }
}

/// The in-memory price cache of `priceCache.ts`: a payload per key for five minutes. The
/// clock is passed in.
struct PriceMemoryCache<Payload> {
    static var lifetimeMs: Double { 5 * 60_000 }

    private var entries: [String: (data: Payload, expiresAt: Double)] = [:]

    var count: Int { entries.count }

    /// `cacheGet(key)`: the payload, or nil when absent or expired (an expired entry is removed).
    mutating func get(_ key: String, now: Double) -> Payload? {
        guard let entry = entries[key] else { return nil }
        if now > entry.expiresAt {
            entries[key] = nil
            return nil
        }
        return entry.data
    }

    mutating func set(_ key: String, _ data: Payload, now: Double) {
        entries[key] = (data, now + Self.lifetimeMs)
    }

    /// `sweepExpiredCacheEntries(now)`: how many entries were removed.
    mutating func sweep(now: Double) -> Int {
        let expired = entries.filter { now > $0.value.expiresAt }.map(\.key)
        for key in expired { entries[key] = nil }
        return expired.count
    }

    mutating func reset() { entries.removeAll() }
}
