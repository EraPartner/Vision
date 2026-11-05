import Foundation

/// Tick values for a categorical (String-keyed) chart axis. Swift Charts labels every
/// category of such an axis whatever `.automatic(desiredCount:)` asks for, so a daily
/// series drew one grid line and one overlapping label per day.
enum ChartAxisTicks {
    /// At most `count` keys spread evenly over `keys`, always including the first and last.
    static func evenlySpaced<Key>(_ keys: [Key], count: Int = 6) -> [Key] {
        guard count > 1, keys.count > count else { return keys }
        let step = Double(keys.count - 1) / Double(count - 1)
        return (0..<count).map { keys[Int((Double($0) * step).rounded())] }
    }
}

/// The value (y) axis of the web chart primitives (`components/charts/*Chart.tsx`): a visx
/// `scaleLinear({ nice: true })` over a padded data range, five ticks (`numYTicks = 5`) drawn
/// with d3's tick rules. Swift Charts' own automatic domain starts at zero and picks its own
/// tick count, which is why native charts looked flat next to the web.
extension ChartAxisTicks {
    private static let e10 = 50.0.squareRoot()
    private static let e5 = 10.0.squareRoot()
    private static let e2 = 2.0.squareRoot()

    /// d3-array `tickIncrement`: a positive step, or the negated reciprocal for sub-unit steps.
    static func tickIncrement(_ start: Double, _ stop: Double, count: Int) -> Double {
        let step = (stop - start) / Double(max(0, count))
        guard step.isFinite, step > 0 else { return 0 }
        let power = floor(log10(step))
        let error = step / pow(10, power)
        let factor: Double = error >= e10 ? 10 : error >= e5 ? 5 : error >= e2 ? 2 : 1
        return power >= 0 ? factor * pow(10, power) : -pow(10, -power) / factor
    }

    /// d3-array `ticks`: about `count` round values inside `start...stop`.
    static func ticks(_ start: Double, _ stop: Double, count: Int = 5) -> [Double] {
        guard start.isFinite, stop.isFinite, count > 0 else { return [] }
        if start == stop { return [start] }
        let low = min(start, stop)
        let high = max(start, stop)
        let step = tickIncrement(low, high, count: count)
        guard step != 0 else { return [] }
        let scale = step > 0 ? step : -step
        var first = step > 0 ? (low / scale).rounded() : (low * scale).rounded()
        var last = step > 0 ? (high / scale).rounded() : (high * scale).rounded()
        func value(_ index: Double) -> Double { step > 0 ? index * scale : index / scale }
        if value(first) < low { first += 1 }
        if value(last) > high { last -= 1 }
        guard last >= first else { return [] }
        return (0...Int(last - first)).map { value(first + Double($0)) }
    }

    /// d3-scale `nice`: widens the domain to round tick boundaries (d3's default count is 10).
    static func niceDomain(_ low: Double, _ high: Double, count: Int = 10) -> ClosedRange<Double> {
        guard low.isFinite, high.isFinite, low < high else { return low...max(low, high) }
        var start = low
        var stop = high
        var previous = 0.0
        for _ in 0..<10 {
            let step = tickIncrement(start, stop, count: count)
            if step == previous { break }
            if step > 0 {
                start = floor(start / step) * step
                stop = ceil(stop / step) * step
            } else if step < 0 {
                start = ceil(start * step) / step
                stop = floor(stop * step) / step
            } else {
                break
            }
            previous = step
        }
        return start...stop
    }

    /// Positions to label on a day-of-month axis (the cash flow forecast's `dayNum`): the days d3
    /// would tick on a linear scale over the day range, so a 30-day month labels 2, 4, ... 30.
    /// `nil` when the days are not one strictly increasing run (a rolling window across months).
    static func dayOfMonthPositions(_ days: [Int], count: Int) -> [Int]? {
        guard let first = days.first, let last = days.last, days == days.sorted(),
            Set(days).count == days.count
        else { return nil }
        let wanted = Set(ticks(Double(first), Double(last), count: count).map { Int($0.rounded()) })
        let positions = days.indices.filter { wanted.contains(days[$0]) }
        return positions.isEmpty ? nil : positions
    }

    /// Line and unstacked-area charts (`LineChart` / `AreaChart` `yScale`): the data range padded
    /// by 8 % (1 when flat), niced. Not zero-based: a slowly moving series fills the plot.
    static func fittedDomain(_ values: [Double]) -> ClosedRange<Double> {
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        let pad = high != low ? (high - low) * 0.08 : 1
        return niceDomain(low - pad, high + pad)
    }

    /// Bar charts (`BarChart` `valueDomain`) and stacked areas: the baseline stays in view and only
    /// the top is padded by 8 %.
    static func zeroBasedDomain(_ values: [Double]) -> ClosedRange<Double> {
        let low = min(0, values.min() ?? 0)
        let high = max(0, values.max() ?? 1)
        let pad = high != low ? (high - low) * 0.08 : 1
        return niceDomain(low, high + pad)
    }
}
