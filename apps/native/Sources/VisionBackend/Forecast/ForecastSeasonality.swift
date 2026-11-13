import Foundation

/// One day of history: the net cash movement on a calendar date.
struct DailyNet: Equatable, Sendable {
    let date: String
    let net: Double
}

/// One forecast value for a calendar date.
struct ForecastPoint: Equatable, Sendable {
    let date: String
    let value: Double

    var jsonValue: JSValue { .object(JSObject([("date", .string(date)), ("value", ForecastJSON.number(value))])) }
}

enum ForecastJSON {
    /// A number as `JSON.stringify` writes it: NaN and the infinities become null.
    static func number(_ value: Double) -> JSValue { value.isFinite ? .number(value) : .null }

    static func points(_ points: [ForecastPoint]) -> JSValue { .array(points.map(\.jsonValue)) }
}

/// The date and averaging helpers the forecast methods share (`seasonality.ts`, `months.ts`,
/// `_densify.ts`, `_statistics.ts`).
///
/// Dates must be real `YYYY-MM-DD` days and amounts finite: the Swift throws where the
/// TypeScript would carry `NaN` through a forecast.
enum ForecastCalendar {
    /// `dayOfWeek(date)`: 0 is Sunday.
    static func dayOfWeek(_ date: String) throws -> Int {
        ((try CalendarDays.epochDay(date) + 4) % 7 + 7) % 7
    }

    /// `dayOfMonth(date)`.
    static func dayOfMonth(_ date: String) throws -> Int { try CalendarDays.parts(date).day }

    /// `monthKey(date)`.
    static func monthKey(_ date: String) -> String { String(date.prefix(7)) }

    /// `orderedMonthKeys(history)`.
    static func orderedMonthKeys(_ history: [DailyNet]) -> [String] {
        Array(Set(history.map { monthKey($0.date) })).sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
    }

    /// `toNumber(divide(addAll(values), n))`: the mean through the decimal type.
    static func decimalMean(_ values: [Double]) throws -> Double {
        let total = DecimalMoney.addAll(try values.map { try DecimalJS($0) })
        return try total.dividedBy(DecimalJS(values.count)).toNumber
    }

    /// `densifyDailyHistory(history, endIso)`: every calendar day from the first observed one
    /// through `end` (or the last observed), with net 0 where nothing was recorded.
    static func densify(_ history: [DailyNet], through end: String? = nil) throws -> [DailyNet] {
        if history.isEmpty { return history }
        var byDate: [String: Double] = [:]
        for row in history { byDate[row.date, default: 0] += row.net.isNaN ? 0 : row.net }
        let sorted = byDate.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
        guard let start = sorted.first, let last = sorted.last else { return history }
        let precedes = { (a: String, b: String) in Array(a.utf16).lexicographicallyPrecedes(Array(b.utf16)) }
        let endText: String
        if let end, !end.isEmpty, !precedes(end, start) { endText = end } else { endText = last }
        let startDay = try CalendarDays.epochDay(start)
        let endDay = try CalendarDays.epochDay(endText)
        var out: [DailyNet] = []
        if endDay >= startDay {
            out.reserveCapacity(endDay - startDay + 1)
            for day in startDay...endDay {
                let iso = try CalendarDays.isoPrefix(dayNumber: day)
                out.append(DailyNet(date: iso, net: byDate[iso] ?? 0))
            }
        }
        return out
    }

    /// `quantile(sortedAsc, percentile)` for a percentile in 0...100.
    static func quantile(_ sorted: [Double], _ percentile: Double) -> Double {
        if sorted.isEmpty { return 0 }
        let index = (percentile / 100) * Double(sorted.count - 1)
        let lower = index.rounded(.down)
        let upper = index.rounded(.up)
        guard lower >= 0, upper < Double(sorted.count) else { return .nan }
        let lowerValue = sorted[Int(lower)]
        if lower == upper { return lowerValue }
        let fraction = index - lower
        return lowerValue * (1 - fraction) + sorted[Int(upper)] * fraction
    }
}

/// `seasonality.ts`: history bucketed by (weekday, day of month), with the weekday bucket and
/// the overall figures as fallbacks for cells with fewer than three samples.
struct SeasonalityBuckets: Sendable {
    struct Stats: Equatable, Sendable {
        let mean: Double
        let variance: Double
        let std: Double
        let n: Int

        static let empty = Stats(mean: 0, variance: 0, std: 0, n: 0)

        init(mean: Double, variance: Double, std: Double, n: Int) {
            self.mean = mean
            self.variance = variance
            self.std = std
            self.n = n
        }

        init(_ values: [Double]) throws {
            guard !values.isEmpty else {
                self = .empty
                return
            }
            let mean = try ForecastCalendar.decimalMean(values)
            var squares = 0.0
            for value in values {
                let deviation = value - mean
                squares += deviation * deviation
            }
            let variance = values.count > 1 ? squares / Double(values.count - 1) : 0
            self.init(mean: mean, variance: variance, std: variance.squareRoot(), n: values.count)
        }
    }

    static let minimumSamples = 3

    private struct Cell: Hashable {
        let weekday: Int
        let day: Int
    }

    private let byWeekdayAndDay: [Cell: Stats]
    private let byWeekday: [Int: Stats]
    let overall: Stats

    /// `buildSeasonalityBuckets(history)`.
    init(_ history: [DailyNet]) throws {
        var cells: [Cell: [Double]] = [:]
        var weekdays: [Int: [Double]] = [:]
        var all: [Double] = []
        for row in history {
            let weekday = try ForecastCalendar.dayOfWeek(row.date)
            let day = try ForecastCalendar.dayOfMonth(row.date)
            cells[Cell(weekday: weekday, day: day), default: []].append(row.net)
            weekdays[weekday, default: []].append(row.net)
            all.append(row.net)
        }
        byWeekdayAndDay = try cells.mapValues { try Stats($0) }
        byWeekday = try weekdays.mapValues { try Stats($0) }
        overall = try Stats(all)
    }

    /// `lookupBucket(buckets, date)`.
    func lookup(_ date: String) throws -> Stats {
        let weekday = try ForecastCalendar.dayOfWeek(date)
        let day = try ForecastCalendar.dayOfMonth(date)
        if let exact = byWeekdayAndDay[Cell(weekday: weekday, day: day)], exact.n >= Self.minimumSamples { return exact }
        if let fallback = byWeekday[weekday], fallback.n >= Self.minimumSamples { return fallback }
        return overall
    }
}
