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
    private var context = ""
    private var labels: [String: String] = [:]
    public private(set) var misses = 0

    public init() {}

    public func label(_ key: String, context: String, make: () -> String) -> String {
        if self.context != context {
            self.context = context
            labels.removeAll(keepingCapacity: true)
        }
        if let cached = labels[key] { return cached }
        misses += 1
        let made = make()
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
