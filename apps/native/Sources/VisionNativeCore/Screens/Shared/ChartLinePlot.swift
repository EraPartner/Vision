import Foundation

/// A price chart's points as plot coordinates, converted once per loaded series instead of on
/// every body pass: `Decimal` to `Double`, epoch milliseconds to a `Date`, and the closes
/// thinned to what the plot can show (`ChartDecimation`). Selection and the readout keep
/// using the full series.
public struct ChartLinePlot: Sendable {
    public struct Mark: Sendable {
        /// The index of the point in the full series.
        public let offset: Int
        public let time: Date
        public let close: Double
    }

    public struct Bar: Sendable {
        public let offset: Int
        public let volume: Double
    }

    public struct Input: Sendable {
        public let time: Decimal
        public let close: Decimal?
        public let volume: Decimal?

        public init(time: Decimal, close: Decimal?, volume: Decimal?) {
            self.time = time
            self.close = close
            self.volume = volume
        }
    }

    /// One time per point of the full series (milliseconds since 1970 as a `Date`).
    public let times: [Date]
    /// Every point with a close.
    public let closeMarks: [Mark]
    /// The closes to draw, thinned when the series is long.
    public let marks: [Mark]
    /// Every close, for the value domain.
    public let closes: [Double]
    /// The points with a volume.
    public let bars: [Bar]
    /// `times` ascend, so the point nearest a time can be found by bisection.
    private let ascending: Bool
    private let closesAscending: Bool
    private let closeTimes: [Date]

    public init(points: [Input], maxMarks: Int = ChartDecimation.threshold) {
        var times: [Date] = []
        times.reserveCapacity(points.count)
        var drawable: [Mark] = []
        var bars: [Bar] = []
        for (offset, point) in points.enumerated() {
            let date = Date(timeIntervalSince1970: NSDecimalNumber(decimal: point.time).doubleValue / 1000)
            times.append(date)
            if let close = point.close {
                let value = NSDecimalNumber(decimal: close).doubleValue
                drawable.append(Mark(offset: offset, time: date, close: value))
            }
            if let volume = point.volume {
                bars.append(Bar(offset: offset, volume: NSDecimalNumber(decimal: volume).doubleValue))
            }
        }
        self.times = times
        closeMarks = drawable
        let closeValues = drawable.map(\.close)
        closes = closeValues
        self.bars = bars
        let kept = ChartDecimation.indices(of: closeValues, maxPoints: maxMarks)
        marks = kept.count == drawable.count ? drawable : kept.map { drawable[$0] }
        ascending = Self.isAscending(times)
        let timesOfCloses = drawable.map(\.time)
        closeTimes = timesOfCloses
        closesAscending = Self.isAscending(timesOfCloses)
    }

    public static func isAscending(_ times: [Date]) -> Bool {
        var position = 1
        while position < times.count {
            if times[position] < times[position - 1] { return false }
            position += 1
        }
        return true
    }

    /// The index of the point whose time is nearest `date`, or `nil` for an empty series.
    public func nearestOffset(to date: Date) -> Int? {
        Self.nearest(in: times, ascending: ascending, to: date)
    }

    /// The index in `closeMarks` of the point with a close nearest `date`.
    public func nearestCloseIndex(to date: Date) -> Int? {
        Self.nearest(in: closeTimes, ascending: closesAscending, to: date)
    }

    /// The index in `times` nearest `date` (bisection when `ascending`).
    public static func nearest(in times: [Date], ascending: Bool, to date: Date) -> Int? {
        guard !times.isEmpty else { return nil }
        guard ascending else {
            return times.indices.min {
                abs(times[$0].timeIntervalSince(date)) < abs(times[$1].timeIntervalSince(date))
            }
        }
        var low = 0
        var high = times.count
        while low < high {
            let middle = (low + high) / 2
            if times[middle] < date { low = middle + 1 } else { high = middle }
        }
        if low == 0 { return 0 }
        if low == times.count { return times.count - 1 }
        let before = date.timeIntervalSince(times[low - 1])
        let after = times[low].timeIntervalSince(date)
        return before <= after ? low - 1 : low
    }
}

/// Keeps the `ChartLinePlot` of the last points it saw. Equal arrays compare in O(1) while
/// they share a buffer, so a hover re-render does not convert the series again.
public final class ChartLinePlotCache {
    private var source: [ResearchChartPoint]?
    private var plot = ChartLinePlot(points: [])
    public private(set) var builds = 0

    public init() {}

    public func plot(for points: [ResearchChartPoint]) -> ChartLinePlot {
        if let last = source, last == points { return plot }
        source = points
        let inputs = points.map { ChartLinePlot.Input(time: $0.time, close: $0.close, volume: $0.volume) }
        plot = ChartLinePlot(points: inputs)
        builds += 1
        return plot
    }
}
