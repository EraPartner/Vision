import Foundation

/// Coordinate geometry only. Values in tooltips and actions remain the original server decimals.
struct ResearchChartBuilderAxisGeometry: Equatable {
    let lower: Double
    let upper: Double
    let logarithmic: Bool
    init(values: [Double], requestsLog: Bool = false, fixed: ClosedRange<Double>? = nil) {
        if let fixed {
            lower = fixed.lowerBound
            upper = fixed.upperBound
            logarithmic = false
            return
        }
        let finite = values.filter(\.isFinite)
        let lo = finite.min() ?? 0
        let hi = finite.max() ?? 1
        logarithmic = requestsLog && lo > 0
        if logarithmic {
            lower = lo * 0.95
            upper = hi * 1.05
        } else {
            let span = (hi - lo) * 0.08
            let padding = span == 0 ? 1 : span
            lower = lo - padding
            upper = hi + padding
        }
    }
    func fraction(_ value: Double) -> Double? {
        guard value.isFinite, !logarithmic || value > 0 else { return nil }
        let start = logarithmic ? log(lower) : lower
        let end = logarithmic ? log(upper) : upper
        let point = logarithmic ? log(value) : value
        guard start.isFinite, end.isFinite, end != start else { return nil }
        return (point - start) / (end - start)
    }
    func tick(_ fraction: Double) -> Double {
        logarithmic ? exp(log(lower) + fraction * (log(upper) - log(lower))) : lower + fraction * (upper - lower)
    }
}

struct ResearchChartBuilderCurveSegment: Equatable {
    let end: CGPoint
    let firstControl: CGPoint
    let secondControl: CGPoint
}
/// Steffen monotone interpolation of already-scaled drawing coordinates, matching the source chart curve.
enum ResearchChartBuilderCurveGeometry {
    static func segments(_ points: [CGPoint]) -> [ResearchChartBuilderCurveSegment] {
        guard points.count > 2 else { return [] }
        var tangents = Array(repeating: CGFloat(0), count: points.count)
        for index in 1..<(points.count - 1) {
            let previous = points[index - 1]
            let point = points[index]
            let next = points[index + 1]
            let h0 = point.x - previous.x
            let h1 = next.x - point.x
            guard h0 > 0, h1 > 0 else { continue }
            let s0 = (point.y - previous.y) / h0
            let s1 = (next.y - point.y) / h1
            let p = (s0 * h1 + s1 * h0) / (h0 + h1)
            tangents[index] = (sign(s0) + sign(s1)) * min(abs(s0), abs(s1), abs(p) / 2)
        }
        let firstWidth = points[1].x - points[0].x
        if firstWidth > 0 { tangents[0] = (3 * (points[1].y - points[0].y) / firstWidth - tangents[1]) / 2 }
        let last = points.count - 1
        let lastWidth = points[last].x - points[last - 1].x
        if lastWidth > 0 {
            tangents[last] = (3 * (points[last].y - points[last - 1].y) / lastWidth - tangents[last - 1]) / 2
        }
        return (1..<points.count).map { index in
            let start = points[index - 1]
            let end = points[index]
            let dx = (end.x - start.x) / 3
            return .init(
                end: end, firstControl: CGPoint(x: start.x + dx, y: start.y + dx * tangents[index - 1]),
                secondControl: CGPoint(x: end.x - dx, y: end.y - dx * tangents[index]))
        }
    }
    private static func sign(_ value: CGFloat) -> CGFloat { value < 0 ? -1 : 1 }
}
