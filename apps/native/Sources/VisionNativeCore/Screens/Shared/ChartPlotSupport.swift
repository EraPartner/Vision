import Foundation

/// The sorted distinct x keys of a set of chart series, and each key's position. Charts need
/// both on every body pass and on every pointer move, and building them sorts every key, so a
/// view keeps one `ChartKeyLayout` per series value (`ChartKeyLayoutCache`).
public struct ChartKeyLayout: Equatable, Sendable {
    public let keys: [String]
    public let index: [String: Int]

    public static let empty = ChartKeyLayout(keys: [])

    public init(keys: [String]) {
        self.keys = keys
        var positions: [String: Int] = [:]
        positions.reserveCapacity(keys.count)
        for (position, key) in keys.enumerated() { positions[key] = position }
        index = positions
    }

    public init(series: [InsightChartSeries]) {
        var distinct = Set<String>()
        for line in series {
            for point in line.points { distinct.insert(point.key) }
        }
        self.init(keys: distinct.sorted())
    }
}

/// Remembers the `ChartKeyLayout` of the last series it saw. Comparing equal arrays is O(1)
/// while the buffer is the same (a hover re-renders with the same series) and O(n) otherwise,
/// both far cheaper than sorting every key again.
public final class ChartKeyLayoutCache {
    private var series: [InsightChartSeries]?
    private var layout = ChartKeyLayout.empty
    /// How often the layout was built, for tests.
    public private(set) var builds = 0

    public init() {}

    public func layout(for series: [InsightChartSeries]) -> ChartKeyLayout {
        if let last = self.series, last == series { return layout }
        self.series = series
        layout = ChartKeyLayout(series: series)
        builds += 1
        return layout
    }
}

/// Strings a chart derives from a point (an accessibility label, a formatted value) for many
/// points on every body pass. The memo keeps them while the formatting context (locale,
/// currency, decimals, language) is unchanged, so a hover re-renders without formatting again.
public final class ChartLabelMemo {
    /// The most labels kept at once. A chart formats one label per point; a series of years of
    /// daily points would otherwise keep every string of every context it was ever drawn with.
    public static let capacity = 2_048

    private var context = ""
    private var labels: [String: String] = [:]
    public private(set) var misses = 0

    public init() {}

    /// How many labels are kept, for tests.
    public var count: Int { labels.count }

    public func label(_ key: String, context: String, make: () -> String) -> String {
        if self.context != context {
            self.context = context
            labels.removeAll(keepingCapacity: true)
        }
        if let cached = labels[key] { return cached }
        misses += 1
        let made = make()
        if labels.count >= Self.capacity { labels.removeAll(keepingCapacity: false) }
        labels[key] = made
        return made
    }
}

/// Thins a long series to what a plot of `maxPoints` columns can show: each bucket keeps its
/// lowest and highest value (and the first and last point overall), in order, so peaks and
/// troughs survive. A series that already fits is returned unchanged.
public enum ChartDecimation {
    /// Series up to this many points are never thinned (about two per pixel of a wide plot).
    public static let threshold = 1_600

    /// The plot width, in points, a line chart is sized for: the widest a card plot gets in the
    /// app window. A narrower plot only has more points than it can resolve.
    public static let linePlotWidth = 960.0

    /// Points per line a chart of `plotWidth` points keeps: one bucket pair (lowest and highest
    /// value) per `bucketPairWidth` points of plot, plus the first and last point.
    public static func budget(plotWidth: Double, bucketPairWidth: Double = 2) -> Int {
        let pairs = max(1, Int((plotWidth / max(bucketPairWidth, 1)).rounded(.up)))
        return pairs * 2 + 2
    }

    /// The per-line budget of the portfolio and home line charts.
    public static let lineBudget = budget(plotWidth: linePlotWidth)

    /// `series` with every line thinned to `maxPoints` (`indices(of:maxPoints:)` over the
    /// matching `coordinates`). With `shared`, all lines keep the union of the x keys any line
    /// kept, so lines that stack still sit on the same x positions. Lines that fit are untouched.
    static func thin(
        _ series: [InsightChartSeries], coordinates: [[Double]], shared: Bool, maxPoints: Int
    ) -> [InsightChartSeries] {
        let kept = coordinates.map { indices(of: $0, maxPoints: maxPoints) }
        guard zip(kept, series).contains(where: { $0.count < $1.points.count }) else { return series }
        if shared {
            var keys = Set<String>()
            for (line, positions) in zip(series, kept) {
                for position in positions { keys.insert(line.points[position].key) }
            }
            return series.map { line in
                let points = line.points.filter { keys.contains($0.key) }
                return points.count == line.points.count
                    ? line : InsightChartSeries(id: line.id, label: line.label, points: points, dashed: line.dashed)
            }
        }
        return zip(series, kept).map { line, positions in
            positions.count == line.points.count
                ? line
                : InsightChartSeries(
                    id: line.id, label: line.label, points: positions.map { line.points[$0] }, dashed: line.dashed)
        }
    }

    /// The indices of `values` to draw, ascending.
    public static func indices(of values: [Double], maxPoints: Int = threshold) -> [Int] {
        let count = values.count
        guard maxPoints >= 4, count > maxPoints else { return Array(values.indices) }
        let buckets = max(1, (maxPoints - 2) / 2)
        let interior = count - 2
        var kept: [Int] = [0]
        kept.reserveCapacity(maxPoints + 2)
        for bucket in 0..<buckets {
            let start = 1 + bucket * interior / buckets
            let end = 1 + (bucket + 1) * interior / buckets
            guard start < end else { continue }
            var low = start
            var high = start
            for position in start..<end {
                if values[position] < values[low] { low = position }
                if values[position] > values[high] { high = position }
            }
            if low == high {
                kept.append(low)
            } else {
                kept.append(min(low, high))
                kept.append(max(low, high))
            }
        }
        kept.append(count - 1)
        return kept
    }
}

/// What a line chart needs from its series, built once per series value: the sorted keys, the
/// lines thinned to `ChartDecimation.lineBudget` points for drawing, and every value as a plot
/// coordinate. Selection, the readout, the x ticks and the y domain use the full `layout` and
/// `values`; only the marks use `drawn`, so nothing a reader sees depends on the thinning.
public struct ChartSeriesPlot: Sendable {
    public let layout: ChartKeyLayout
    public let drawn: [InsightChartSeries]
    /// Every point of every line, for the value domain.
    public let values: [Double]

    public static let empty = ChartSeriesPlot(series: [])

    public init(series: [InsightChartSeries], shared: Bool = false, maxPoints: Int = ChartDecimation.lineBudget) {
        let coordinates = series.map { line in
            line.points.map { NSDecimalNumber(decimal: $0.value).doubleValue }
        }
        layout = ChartKeyLayout(series: series)
        values = coordinates.flatMap { $0 }
        drawn = ChartDecimation.thin(series, coordinates: coordinates, shared: shared, maxPoints: maxPoints)
    }
}

/// Remembers the `ChartSeriesPlot` of the last series it saw, like `ChartKeyLayoutCache`.
public final class ChartSeriesPlotCache {
    private var series: [InsightChartSeries]?
    private var shared = false
    private var plot = ChartSeriesPlot.empty
    /// How often the plot was built, for tests.
    public private(set) var builds = 0

    public init() {}

    public func plot(for series: [InsightChartSeries], shared: Bool = false) -> ChartSeriesPlot {
        if let last = self.series, self.shared == shared, last == series { return plot }
        self.series = series
        self.shared = shared
        plot = ChartSeriesPlot(series: series, shared: shared)
        builds += 1
        return plot
    }
}

/// The accessibility label and value of each point of a line, kept while the line and the
/// formatting context are unchanged so a hover does not format a thousand points again.
public final class ChartMarkLabelCache {
    public struct Mark: Equatable, Sendable {
        public let label: String
        public let value: String

        public init(label: String, value: String) {
            self.label = label
            self.value = value
        }
    }

    private struct Entry {
        let context: String
        let line: InsightChartSeries
        let marks: [Mark]
    }

    /// The most lines kept at once; the line that no longer fits replaces the oldest ones.
    public static let capacity = 8

    private var entries: [String: Entry] = [:]
    private var order: [String] = []
    /// How often a line's marks were built, for tests.
    public private(set) var builds = 0

    public init() {}

    /// How many lines are kept, for tests.
    public var count: Int { entries.count }

    /// One `Mark` per point of `line`, in order.
    public func marks(for line: InsightChartSeries, context: String, make: (InsightChartPoint) -> Mark) -> [Mark] {
        if let entry = entries[line.id], entry.context == context, entry.line == line { return entry.marks }
        let marks = line.points.map(make)
        if entries[line.id] == nil {
            order.append(line.id)
            while order.count > Self.capacity {
                entries[order.removeFirst()] = nil
            }
        }
        entries[line.id] = Entry(context: context, line: line, marks: marks)
        builds += 1
        return marks
    }
}

/// Remembers a value derived from an equatable input (a chart's series built from a
/// snapshot list) so a body pass does not rebuild it while the input is unchanged.
public final class ChartDerivedMemo<Input: Equatable, Output> {
    private var input: Input?
    private var output: Output?
    /// How often the output was built, for tests.
    public private(set) var builds = 0

    public init() {}

    public func output(for input: Input, make: () -> Output) -> Output {
        if let output, let last = self.input, last == input { return output }
        let made = make()
        self.input = input
        output = made
        builds += 1
        return made
    }
}
