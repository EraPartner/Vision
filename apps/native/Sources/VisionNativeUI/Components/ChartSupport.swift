import Charts
import SwiftUI
import VisionNativeCore

/// Shared look of the web chart primitives (`components/charts/*`): the legend row, the value
/// axis, the area gradient and the monotone curve. Every native chart uses these so the rules
/// (legend above the plot, dashed grid, five niced ticks, smoothed lines) live in one place.

// MARK: Legend

/// One `ChartLegendItem`: a 10pt dot, or a 16x2 dashed rule for a dashed series.
struct ChartLegendItem: Identifiable, Equatable {
    let id: String
    let label: String
    let color: Color
    var dashed = false
}

/// Where a chart's legend sits. The web `ChartCard` renders it under the plot; statistics and
/// dashboard charts place a `ChartLegend` above it.
enum ChartLegendPlacement: Equatable {
    case top
    case bottomLeading
    case bottomCenter
    case hidden
}

/// `ChartLegend`: `flex flex-wrap gap-x-4 gap-y-1 type-footnote text-label-secondary`.
struct ChartLegendRow: View {
    let items: [ChartLegendItem]
    var centered = false
    @Environment(\.visionTheme) private var theme

    private var font: Font {
        VisionFonts.body(CGFloat(DesignTokens.Typography.footnote.size), weight: 400, relativeTo: .footnote)
    }

    var body: some View {
        if !items.isEmpty {
            ChartLegendLayout(horizontalSpacing: 16, verticalSpacing: 4, centered: centered) {
                ForEach(items) { item in
                    HStack(spacing: 8) {
                        swatch(item)
                        Text(item.label).font(font).foregroundStyle(theme.secondaryLabel)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .frame(maxWidth: .infinity, alignment: centered ? .center : .leading)
        }
    }

    @ViewBuilder
    private func swatch(_ item: ChartLegendItem) -> some View {
        if item.dashed {
            Path { path in
                path.move(to: CGPoint(x: 0, y: 1))
                path.addLine(to: CGPoint(x: 16, y: 1))
            }
            .stroke(item.color, style: StrokeStyle(lineWidth: 2, dash: [3, 3]))
            .frame(width: 16, height: 2)
            .accessibilityHidden(true)
        } else {
            Circle().fill(item.color).frame(width: 10, height: 10).accessibilityHidden(true)
        }
    }
}

/// Wraps legend entries into rows with separate column and row gaps.
private struct ChartLegendLayout: Layout {
    var horizontalSpacing: CGFloat
    var verticalSpacing: CGFloat
    var centered: Bool

    private struct Row {
        var members: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            var row = rows.removeLast()
            let gap = row.members.isEmpty ? 0 : horizontalSpacing
            if !row.members.isEmpty, row.width + gap + size.width > width {
                rows.append(row)
                row = Row()
            }
            row.width += (row.members.isEmpty ? 0 : horizontalSpacing) + size.width
            row.height = max(row.height, size.height)
            row.members.append(index)
            rows.append(row)
        }
        return rows
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let laidOut = rows(subviews, width: proposal.width ?? .infinity)
        let height = laidOut.reduce(CGFloat(0)) { $0 + $1.height } + verticalSpacing * CGFloat(max(0, laidOut.count - 1))
        let widest = laidOut.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? widest, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(subviews, width: bounds.width) {
            var x = centered ? bounds.minX + max(0, (bounds.width - row.width) / 2) : bounds.minX
            for index in row.members {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + horizontalSpacing
            }
            y += row.height + verticalSpacing
        }
    }
}

// MARK: Axis

/// Text style of axis tick labels (`ChartAxis.tsx`: 11px, tabular numbers, muted foreground).
enum ChartTickText {
    static var font: Font { VisionFonts.body(11, weight: 400, relativeTo: .caption2).monospacedDigit() }
}

/// The value axis of the web charts: the domain is set explicitly (padded and niced, see
/// `ChartAxisTicks`), about five ticks, and a dashed 35 % grid (`strokeDasharray="2 4"`).
struct VisionChartYAxis: ViewModifier {
    let domain: ClosedRange<Double>
    var position: AxisMarkPosition = .leading
    var tickCount = 5
    /// Hides the axis and grid (a sparkline) while keeping the explicit domain.
    var hidden = false
    let label: (Double) -> String
    @Environment(\.visionTheme) private var theme

    func body(content: Content) -> some View {
        content
            .chartYScale(domain: domain)
            .chartYAxis {
                if !hidden {
                    AxisMarks(
                        position: position,
                        values: ChartAxisTicks.ticks(domain.lowerBound, domain.upperBound, count: tickCount)
                    ) { value in
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 1, dash: [2, 4]))
                            .foregroundStyle(theme.border.opacity(0.35))
                        AxisValueLabel {
                            if let number = value.as(Double.self) {
                                Text(label(number)).font(ChartTickText.font).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                    }
                }
            }
    }
}

extension View {
    /// Applies `VisionChartYAxis`.
    func visionChartYAxis(
        domain: ClosedRange<Double>, position: AxisMarkPosition = .leading, tickCount: Int = 5,
        hidden: Bool = false, label: @escaping (Double) -> String
    ) -> some View {
        modifier(
            VisionChartYAxis(
                domain: domain, position: position, tickCount: tickCount, hidden: hidden, label: label))
    }
}

// MARK: Fills and curves

enum ChartFill {
    /// `AreaChart`'s `linearGradient`: the series colour at 22 % fading to clear at the baseline.
    static func areaGradient(_ color: Color) -> LinearGradient {
        LinearGradient(
            colors: [color.opacity(0.22), color.opacity(0)], startPoint: .top, endPoint: .bottom)
    }

    /// Fill of stacked areas (`fillOpacity={0.55}`).
    static let stackedOpacity = 0.55
}

/// d3's `curveMonotoneX` (the web's `type="monotone"`), for charts drawn as plain paths.
enum ChartCurve {
    /// The tangent slope at every point of `points` (sorted by x), Fritsch-Carlson as in d3-shape.
    static func tangents(_ points: [CGPoint]) -> [Double] {
        let count = points.count
        guard count > 1 else { return Array(repeating: 0, count: count) }
        func sign(_ value: Double) -> Double { value < 0 ? -1 : 1 }
        func slope3(_ a: CGPoint, _ b: CGPoint, _ c: CGPoint) -> Double {
            let h0 = Double(b.x - a.x)
            let h1 = Double(c.x - b.x)
            guard h0 + h1 != 0, h0 != 0, h1 != 0 else { return 0 }
            let s0 = Double(b.y - a.y) / h0
            let s1 = Double(c.y - b.y) / h1
            let p = (s0 * h1 + s1 * h0) / (h0 + h1)
            let value = (sign(s0) + sign(s1)) * min(abs(s0), abs(s1), 0.5 * abs(p))
            return value.isFinite ? value : 0
        }
        func slope2(_ a: CGPoint, _ b: CGPoint, _ t: Double) -> Double {
            let h = Double(b.x - a.x)
            return h != 0 ? (3 * Double(b.y - a.y) / h - t) / 2 : t
        }
        var result = Array(repeating: 0.0, count: count)
        if count > 2 {
            for index in 1..<(count - 1) { result[index] = slope3(points[index - 1], points[index], points[index + 1]) }
            result[0] = slope2(points[0], points[1], result[1])
            result[count - 1] = slope2(points[count - 2], points[count - 1], result[count - 2])
        } else {
            let slope = Double(points[1].y - points[0].y) / max(Double(points[1].x - points[0].x), .leastNonzeroMagnitude)
            result = [slope, slope]
        }
        return result
    }

    /// Adds the smoothed segments from `points[0]` through the last point to `path`
    /// (the caller has already moved to `points[0]`).
    static func addSegments(_ points: [CGPoint], to path: inout Path) {
        guard points.count > 1 else { return }
        let slopes = tangents(points)
        for index in 1..<points.count {
            let a = points[index - 1]
            let b = points[index]
            let dx = (b.x - a.x) / 3
            path.addCurve(
                to: b,
                control1: CGPoint(x: a.x + dx, y: a.y + dx * CGFloat(slopes[index - 1])),
                control2: CGPoint(x: b.x - dx, y: b.y - dx * CGFloat(slopes[index])))
        }
    }

    /// The smoothed line through `points`.
    static func line(_ points: [CGPoint]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        addSegments(points, to: &path)
        return path
    }

    /// The smoothed line closed down to `baseline` (an area fill).
    static func area(_ points: [CGPoint], baseline: CGFloat) -> Path {
        var path = Path()
        guard let first = points.first, let last = points.last else { return path }
        path.move(to: CGPoint(x: first.x, y: baseline))
        path.addLine(to: first)
        addSegments(points, to: &path)
        path.addLine(to: CGPoint(x: last.x, y: baseline))
        path.closeSubpath()
        return path
    }
}
