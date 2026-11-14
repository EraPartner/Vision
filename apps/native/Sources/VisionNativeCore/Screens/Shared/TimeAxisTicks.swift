import Foundation

/// d3's `scaleTime().ticks(count)` (d3-time `ticks`): calendar-aligned tick dates at the
/// interval whose length is closest to `span / count`, in local time. Swift Charts'
/// `.automatic(desiredCount:)` picks coarser intervals, which left the market chart with far
/// fewer date labels than the web `AreaChart`.
public enum TimeAxisTicks {
    private struct Interval {
        let component: Calendar.Component
        let step: Int
        let seconds: Double
    }

    private static let minute = 60.0
    private static let hour = 3_600.0
    private static let day = 86_400.0
    private static let week = 604_800.0
    private static let month = 2_592_000.0
    private static let year = 31_536_000.0

    /// d3-time's `tickIntervals` from one minute up (the charts never span less).
    private static let intervals: [Interval] = [
        Interval(component: .minute, step: 1, seconds: minute),
        Interval(component: .minute, step: 5, seconds: 5 * minute),
        Interval(component: .minute, step: 15, seconds: 15 * minute),
        Interval(component: .minute, step: 30, seconds: 30 * minute),
        Interval(component: .hour, step: 1, seconds: hour),
        Interval(component: .hour, step: 3, seconds: 3 * hour),
        Interval(component: .hour, step: 6, seconds: 6 * hour),
        Interval(component: .hour, step: 12, seconds: 12 * hour),
        Interval(component: .day, step: 1, seconds: day),
        Interval(component: .day, step: 2, seconds: 2 * day),
        Interval(component: .weekOfYear, step: 1, seconds: week),
        Interval(component: .month, step: 1, seconds: month),
        Interval(component: .month, step: 3, seconds: 3 * month),
        Interval(component: .year, step: 1, seconds: year),
    ]

    /// The tick dates between `start` and `end` (both included when they fall on a tick).
    public static func values(from start: Date, to end: Date, count: Int, calendar: Calendar = .current) -> [Date] {
        guard count > 0, end > start else { return [] }
        let target = end.timeIntervalSince(start) / Double(count)
        let interval: Interval
        if let index = intervals.firstIndex(where: { $0.seconds > target }) {
            if index == 0 {
                interval = intervals[0]
            } else {
                // d3: the neighbour whose length is closer to the target, by ratio.
                let lower = intervals[index - 1]
                let upper = intervals[index]
                interval = target / lower.seconds < upper.seconds / target ? lower : upper
            }
        } else {
            // Beyond a year: whole years at a nice step (d3 `tickStep` over years).
            let years = target / year
            interval = Interval(component: .year, step: niceStep(years), seconds: year)
        }
        return ticks(from: start, to: end, interval: interval, calendar: calendar)
    }

    private static func niceStep(_ value: Double) -> Int {
        guard value > 1 else { return 1 }
        let power = pow(10, (log10(value)).rounded(.down))
        let error = value / power
        let factor: Double = error >= 7.07 ? 10 : error >= 3.16 ? 5 : error >= 1.41 ? 2 : 1
        return max(1, Int(factor * power))
    }

    private static func ticks(from start: Date, to end: Date, interval: Interval, calendar: Calendar) -> [Date] {
        guard var tick = alignedStart(start, interval: interval, calendar: calendar) else { return [] }
        var result: [Date] = []
        var guardCount = 0
        // d3's `timeDay.every(2)` keeps days whose day-of-month is `1 + k·step`, so the count
        // restarts on the 1st of each month: step one day at a time and filter.
        let filtersDays = interval.component == .day && interval.step > 1
        let advance = filtersDays ? 1 : interval.step
        while tick <= end, guardCount < 10_000 {
            let keeps = !filtersDays || (calendar.component(.day, from: tick) - 1) % interval.step == 0
            if tick >= start, keeps { result.append(tick) }
            guard let next = calendar.date(byAdding: interval.component, value: advance, to: tick) else { break }
            tick = next
            guardCount += 1
        }
        return result
    }

    /// The interval boundary at or before `date`, aligned as d3's `every(step)` aligns: minutes,
    /// hours, months and years on multiples of the step, days on day-of-month `1 + k·step`,
    /// weeks on the calendar's first weekday.
    private static func alignedStart(_ date: Date, interval: Interval, calendar: Calendar) -> Date? {
        switch interval.component {
        case .minute, .hour:
            let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            var aligned = parts
            if interval.component == .minute {
                aligned.minute = (parts.minute ?? 0) / interval.step * interval.step
            } else {
                aligned.minute = 0
                aligned.hour = (parts.hour ?? 0) / interval.step * interval.step
            }
            return calendar.date(from: aligned)
        case .day:
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            var aligned = parts
            aligned.day = ((parts.day ?? 1) - 1) / interval.step * interval.step + 1
            return calendar.date(from: aligned)
        case .weekOfYear:
            return calendar.dateInterval(of: .weekOfYear, for: date)?.start
        case .month:
            let parts = calendar.dateComponents([.year, .month], from: date)
            var aligned = parts
            aligned.month = ((parts.month ?? 1) - 1) / interval.step * interval.step + 1
            aligned.day = 1
            return calendar.date(from: aligned)
        default:
            let parts = calendar.dateComponents([.year], from: date)
            let year = (parts.year ?? 1970) / interval.step * interval.step
            return calendar.date(from: DateComponents(year: year, month: 1, day: 1))
        }
    }
}
