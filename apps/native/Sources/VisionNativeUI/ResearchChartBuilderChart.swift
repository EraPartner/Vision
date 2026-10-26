import SwiftUI
import VisionNativeCore

struct ResearchChartBuilderMark: Identifiable, Equatable {
    let id: String
    let label: String
    let kind: String
    let axis: String
    let color: Color
    var dashed = false
    var width: CGFloat = 1.5
    var opacity: Double = 0.18
}
struct ResearchChartBuilderChart: View {
    let rows: [AnalysisRow]
    let marks: [ResearchChartBuilderMark]
    let logLeft: Bool
    let rebased: Bool
    let oscillator: String?
    let shell: NativeShellModel
    @State private var selected: Int?
    @State private var geometryCache = ResearchChartBuilderGeometryCache()
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    private var hasRight: Bool { marks.contains { $0.axis == "right" } }
    private var references: [Double] { oscillator == "rsi" ? [70, 30] : oscillator == "macd" ? [0] : [] }
    private var height: CGFloat { oscillator == nil ? 400 : 160 }
    var body: some View {
        let settings = shell.settings
        let labelColor = theme.secondaryLabel
        let gridColor = theme.border.opacity(0.35)
        let showsRight = hasRight
        let referenceLines = references
        let kind = oscillator
        let isRebased = rebased
        let cursor = selected
        // The axes and times only change with the rows and marks, not with the pointer.
        let geometryNow = geometryCache.snapshot(
            rows: rows, marks: marks, logLeft: logLeft, oscillator: oscillator, references: referenceLines)
        VStack(alignment: .leading, spacing: 10) {
            GeometryReader { geometry in
                let plot = CGRect(
                    x: 58, y: 12, width: max(1, geometry.size.width - (hasRight ? 116 : 72)),
                    height: max(1, geometry.size.height - 48))
                let left = geometryNow.left
                let right = geometryNow.right
                ZStack(alignment: .topLeading) {
                    ResearchChartBuilderMarkLayer(
                        rows: rows, marks: marks, left: left, right: right, plot: plot, gain: theme.gain,
                        loss: theme.loss
                    )
                    .equatable()
                    Canvas { context, _ in
                        for position in 0...4 {
                            let fraction = Double(position) / 4
                            let y = plot.maxY - CGFloat(fraction) * plot.height
                            var grid = Path()
                            grid.move(to: CGPoint(x: plot.minX, y: y))
                            grid.addLine(to: CGPoint(x: plot.maxX, y: y))
                            context.stroke(
                                grid, with: .color(gridColor),
                                style: StrokeStyle(lineWidth: 1, dash: [2, 4]))
                            context.draw(
                                Text(
                                    ResearchChartBuilderChartText.tick(
                                        left.tick(fraction), left: true, rebased: isRebased, oscillator: kind,
                                        settings: settings)
                                ).font(.caption2).foregroundColor(
                                    labelColor), at: CGPoint(x: plot.minX - 7, y: y), anchor: .trailing)
                            if showsRight {
                                context.draw(
                                    Text(
                                        ResearchChartBuilderChartText.tick(
                                            right.tick(fraction), left: false, rebased: isRebased, oscillator: kind,
                                            settings: settings)
                                    ).font(.caption2).foregroundColor(
                                        labelColor), at: CGPoint(x: plot.maxX + 7, y: y), anchor: .leading)
                            }
                        }
                        for reference in referenceLines {
                            if let fraction = left.fraction(reference) {
                                let y = plot.maxY - CGFloat(fraction) * plot.height
                                var line = Path()
                                line.move(to: CGPoint(x: plot.minX, y: y))
                                line.addLine(to: CGPoint(x: plot.maxX, y: y))
                                context.stroke(
                                    line, with: .color(labelColor.opacity(0.6)),
                                    style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                                if kind == "rsi" {
                                    context.draw(
                                        Text(String(Int(reference))).font(.caption2).foregroundColor(
                                            labelColor), at: CGPoint(x: plot.maxX - 4, y: y - 6),
                                        anchor: .trailing)
                                }
                            }
                        }
                        let count = max(2, Int(plot.width / 90))
                        if let first = time(rows.first), let last = time(rows.last) {
                            for index in 0..<count {
                                let fraction = Double(index) / Double(count - 1)
                                let milliseconds = first + (last - first) * fraction
                                let date = Date(timeIntervalSince1970: milliseconds / 1000)
                                context.draw(
                                    Text(
                                        VisionFormat.appDate(
                                            date, format: settings.dateFormat, timeZone: .current)
                                    ).font(.caption2).foregroundColor(labelColor),
                                    at: CGPoint(x: plot.minX + CGFloat(fraction) * plot.width, y: plot.maxY + 20))
                            }
                        }
                        if let cursor, rows.indices.contains(cursor), let x = xPosition(rows[cursor], plot: plot) {
                            var line = Path()
                            line.move(to: CGPoint(x: x, y: plot.minY))
                            line.addLine(to: CGPoint(x: x, y: plot.maxY))
                            context.stroke(
                                line, with: .color(labelColor.opacity(0.5)),
                                style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        }
                    }.allowsHitTesting(false).accessibilityHidden(true)
                    Rectangle().fill(.clear).contentShape(Rectangle()).frame(width: plot.width, height: plot.height)
                        .offset(x: plot.minX, y: plot.minY)
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let point): select(point.x, plot: plot, times: geometryNow.times)
                            case .ended: selected = nil
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 0).onChanged { value in
                                focused = true
                                select(value.location.x, plot: plot, times: geometryNow.times)
                            })
                }
            }.frame(height: height).focusable().focused($focused).focusEffectDisabled()
                .onKeyPress(.leftArrow) {
                    move(-1)
                    return .handled
                }.onKeyPress(.rightArrow) {
                    move(1)
                    return .handled
                }
                .onKeyPress(.escape) {
                    selected = nil
                    return .handled
                }.onChange(of: focused) { _, value in if !value { selected = nil } }
                .onChange(of: rows) { _, _ in selected = nil }.accessibilityLabel(
                    shell.strings.t(oscillator == nil ? "research.builder.chartHelp" : "research.builder.oscillator"))
            if let selected, rows.indices.contains(selected) { tooltip(rows[selected]) }
        }
    }
    private func time(_ row: AnalysisRow?) -> Double? {
        row?["time"]?.decimalValue.map { NSDecimalNumber(decimal: $0).doubleValue }
    }
    private func xPosition(_ row: AnalysisRow, plot: CGRect) -> CGFloat? {
        guard let value = time(row), let first = time(rows.first), let last = time(rows.last) else { return nil }
        return plot.minX + CGFloat(last == first ? 0.5 : (value - first) / (last - first)) * plot.width
    }
    private func select(_ localX: CGFloat, plot: CGRect, times: [Double]) {
        guard let first = time(rows.first), let last = time(rows.last) else {
            selected = nil
            return
        }
        let target = first + Double(min(max(localX / plot.width, 0), 1)) * (last - first)
        let nearest = times.indices.min { abs(times[$0] - target) < abs(times[$1] - target) }
        if nearest != selected { selected = nearest }
    }
    private func move(_ step: Int) {
        if !rows.isEmpty { selected = min(max((selected ?? (step > 0 ? -1 : rows.count)) + step, 0), rows.count - 1) }
    }
    private func tooltip(_ row: AnalysisRow) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if let milliseconds = row["time"]?.decimalValue {
                Text(
                    VisionFormat.appDate(
                        ResearchMarketDisplay.date(milliseconds), format: shell.settings.dateFormat, timeZone: .current)
                ).font(.caption.weight(.medium))
            }
            ForEach(marks) { mark in
                if let value = row[mark.id]?.decimalValue {
                    HStack {
                        Circle().fill(mark.color).frame(width: 7, height: 7).accessibilityHidden(true)
                        Text(mark.label)
                        Spacer()
                        Text(
                            oscillator == nil
                                ? value.formatted(
                                    Decimal.FormatStyle(locale: shell.settings.numberFormat.locale).precision(
                                        .fractionLength(0...2))) : ResearchCompareStyle.fixed(value, digits: 2)
                        ).monospacedDigit()
                    }.font(.caption)
                }
            }
        }.padding(12).background(theme.card, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.control)).overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.control).stroke(theme.border))
    }
}

/// Server OHLC, rebased prices, and indicator values enter here unchanged; the layer only draws marks.
private struct ResearchChartBuilderMarkLayer: View, Equatable {
    let rows: [AnalysisRow]
    let marks: [ResearchChartBuilderMark]
    let left: ResearchChartBuilderAxisGeometry
    let right: ResearchChartBuilderAxisGeometry
    let plot: CGRect
    let gain: Color
    let loss: Color

    /// What the layer draws; the pointer moving over the chart leaves all of it unchanged.
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.plot == rhs.plot && lhs.left == rhs.left && lhs.right == rhs.right && lhs.gain == rhs.gain
            && lhs.loss == rhs.loss && lhs.marks == rhs.marks && lhs.rows == rhs.rows
    }

    var body: some View {
        Canvas { context, _ in
            context.clip(to: Path(plot))
            let first = time(rows.first) ?? 0
            let last = time(rows.last) ?? 1
            let barWidth = max(1, plot.width / CGFloat(max(1, rows.count)) * 0.6)
            func x(_ row: AnalysisRow) -> CGFloat {
                plot.minX + CGFloat(last == first ? 0.5 : ((time(row) ?? first) - first) / (last - first)) * plot.width
            }
            func y(_ value: Decimal?, _ axis: ResearchChartBuilderAxisGeometry) -> CGFloat? {
                value.flatMap { axis.fraction(NSDecimalNumber(decimal: $0).doubleValue) }.map {
                    plot.maxY - CGFloat($0) * plot.height
                }
            }
            for mark in marks.filter({ $0.kind == "bar" }) {
                let axis = mark.axis == "right" ? right : left
                let baseline =
                    axis.fraction(max(0, axis.lower)).map { plot.maxY - CGFloat($0) * plot.height } ?? plot.maxY
                for row in rows {
                    if let value = y(row[mark.id]?.decimalValue, axis) {
                        context.fill(
                            Path(
                                CGRect(
                                    x: x(row) - barWidth / 2, y: min(value, baseline), width: barWidth,
                                    height: abs(baseline - value))), with: .color(mark.color.opacity(mark.opacity)))
                    }
                }
            }
            for mark in marks.filter({ $0.kind == "area" }) {
                let axis = mark.axis == "right" ? right : left
                for segment in segments(mark.id, axis: axis, x: x, y: y) {
                    guard let start = segment.first, let end = segment.last else { continue }
                    var area = path(segment)
                    area.addLine(to: CGPoint(x: end.x, y: plot.maxY))
                    area.addLine(to: CGPoint(x: start.x, y: plot.maxY))
                    area.closeSubpath()
                    context.fill(area, with: .color(mark.color.opacity(mark.opacity)))
                    context.stroke(path(segment), with: .color(mark.color), lineWidth: mark.width)
                }
            }
            for mark in marks.filter({ $0.kind == "candlestick" }) {
                let axis = mark.axis == "right" ? right : left
                for row in rows {
                    guard let open = row[mark.id + "_o"]?.decimalValue, let close = row[mark.id]?.decimalValue,
                        let high = y(row[mark.id + "_h"]?.decimalValue, axis),
                        let low = y(row[mark.id + "_l"]?.decimalValue, axis),
                        let o = y(open, axis), let c = y(close, axis)
                    else { continue }
                    let color = close >= open ? gain : loss
                    var wick = Path()
                    wick.move(to: CGPoint(x: x(row), y: high))
                    wick.addLine(to: CGPoint(x: x(row), y: low))
                    context.stroke(wick, with: .color(color), lineWidth: 1)
                    context.fill(
                        Path(
                            CGRect(x: x(row) - barWidth / 2, y: min(o, c), width: barWidth, height: max(1, abs(o - c)))),
                        with: .color(color))
                }
            }
            for mark in marks.filter({ $0.kind == "line" }) {
                let axis = mark.axis == "right" ? right : left
                for segment in segments(mark.id, axis: axis, x: x, y: y) {
                    context.stroke(
                        path(segment), with: .color(mark.color),
                        style: StrokeStyle(lineWidth: mark.width, dash: mark.dashed ? [4, 4] : []))
                }
            }
        }.allowsHitTesting(false).accessibilityHidden(true)
    }
    private func time(_ row: AnalysisRow?) -> Double? {
        row?["time"]?.decimalValue.map { NSDecimalNumber(decimal: $0).doubleValue }
    }
    private func segments(
        _ key: String, axis: ResearchChartBuilderAxisGeometry, x: (AnalysisRow) -> CGFloat,
        y: (Decimal?, ResearchChartBuilderAxisGeometry) -> CGFloat?
    ) -> [[CGPoint]] {
        var result: [[CGPoint]] = []
        var points: [CGPoint] = []
        for row in rows {
            if let position = y(row[key]?.decimalValue, axis) {
                points.append(CGPoint(x: x(row), y: position))
            } else if !points.isEmpty {
                result.append(points)
                points = []
            }
        }
        if !points.isEmpty { result.append(points) }
        return result
    }
    private func path(_ points: [CGPoint]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        if points.count > 2 {
            for segment in ResearchChartBuilderCurveGeometry.segments(points) {
                path.addCurve(to: segment.end, control1: segment.firstControl, control2: segment.secondControl)
            }
        } else {
            for point in points.dropFirst() { path.addLine(to: point) }
        }
        return path
    }
}

private enum ResearchChartBuilderChartText {
    static func tick(_ value: Double, left: Bool, rebased: Bool, oscillator: String?, settings: NativeAppSettings)
        -> String
    {
        if oscillator != nil { return ResearchCompareStyle.fixed(Decimal(value), digits: oscillator == "rsi" ? 0 : 2) }
        return Decimal(value).formatted(
            Decimal.FormatStyle(locale: settings.numberFormat.locale).precision(
                .fractionLength(0...(left && rebased ? 0 : 3))))
    }
}

/// The chart's axis geometry and row times, kept while the rows and marks are the ones they were
/// built from. Equal row arrays compare in O(1) while they share a buffer.
final class ResearchChartBuilderGeometryCache {
    struct Snapshot {
        let left: ResearchChartBuilderAxisGeometry
        let right: ResearchChartBuilderAxisGeometry
        /// One time per row (the first row's time when a row has none), for the nearest-row search.
        let times: [Double]
    }

    private var rows: [AnalysisRow]?
    private var marks: [ResearchChartBuilderMark] = []
    private var logLeft = false
    private var oscillator: String?
    private var snapshot: Snapshot?

    func snapshot(
        rows: [AnalysisRow], marks: [ResearchChartBuilderMark], logLeft: Bool, oscillator: String?,
        references: [Double]
    ) -> Snapshot {
        if let snapshot, let cached = self.rows, cached == rows, self.marks == marks, self.logLeft == logLeft,
            self.oscillator == oscillator
        {
            return snapshot
        }
        self.rows = rows
        self.marks = marks
        self.logLeft = logLeft
        self.oscillator = oscillator
        let made = Snapshot(
            left: axis("left", rows: rows, marks: marks, logLeft: logLeft, oscillator: oscillator, references: references),
            right: axis("right", rows: rows, marks: marks, logLeft: logLeft, oscillator: oscillator, references: references),
            times: Self.times(rows))
        snapshot = made
        return made
    }

    private static func time(_ row: AnalysisRow) -> Double? {
        row["time"]?.decimalValue.map { NSDecimalNumber(decimal: $0).doubleValue }
    }

    private static func times(_ rows: [AnalysisRow]) -> [Double] {
        let first = rows.first.flatMap(time) ?? 0
        return rows.map { time($0) ?? first }
    }

    private func axis(
        _ name: String, rows: [AnalysisRow], marks: [ResearchChartBuilderMark], logLeft: Bool, oscillator: String?,
        references: [Double]
    ) -> ResearchChartBuilderAxisGeometry {
        let values = marks.filter { $0.axis == name }.flatMap { mark in
            rows.flatMap { row -> [Double] in
                let keys = mark.kind == "candlestick" ? [mark.id + "_h", mark.id + "_l"] : [mark.id]
                return keys.compactMap { row[$0]?.decimalValue }.map { NSDecimalNumber(decimal: $0).doubleValue }
            }
        }
        return .init(
            values: values + (name == "left" && oscillator != nil ? references : []),
            requestsLog: name == "left" && logLeft, fixed: oscillator == "rsi" ? 0...100 : nil)
    }
}
