import Charts
import SwiftUI
import VisionNativeCore

/// Values, inferred axes and pie percentages/angles arrive from the source TS
/// presentation helper. Native arithmetic below is only drawing and hit testing.
struct AIChatToolChart: View {
    let presentation: AIChatToolPresentation
    let shell: NativeShellModel
    @State private var selected: Int?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var colors: [Color] {
        [
            theme.palette.chart1, theme.palette.chart2, theme.palette.chart3, theme.palette.chart4,
            theme.palette.chart5, theme.palette.chart6, theme.palette.chart7, theme.palette.chart8,
        ].map { Color(token: $0) }
    }
    private func color(_ index: Int) -> Color { colors[index % colors.count] }
    private var noData: Bool { presentation.rows.isEmpty || presentation.yKeys.isEmpty }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if noData {
                Text(strings.t("aiChat.noChartData")).font(.caption).foregroundStyle(theme.secondaryLabel)
            } else if presentation.renderAs == .pie {
                pie
            } else {
                cartesian
                if presentation.yKeys.count > 1 {
                    ChartLegendRow(
                        items: presentation.yKeys.enumerated().map { index, key in
                            ChartLegendItem(id: String(index) + key, label: key, color: color(index))
                        }, centered: true)
                }
            }
            if let selected {
                readout(selected)
            }
        }.onChange(of: presentation) { _, _ in selected = nil }
    }
    private var cartesian: some View {
        Chart {
            ForEach(Array(presentation.yKeys.enumerated()), id: \.offset) { series, key in
                ForEach(presentation.rows.indices, id: \.self) { index in
                    cartesianMark(index: index, key: key, series: series)
                }
            }
            if let selected, presentation.rows.indices.contains(selected) {
                RuleMark(x: .value(presentation.xKey, Double(selected))).foregroundStyle(
                    theme.secondaryLabel.opacity(0.4))
            }
        }.chartXScale(domain: -0.5...max(0.5, Double(presentation.rows.count) - 0.5))
            .chartLegend(.hidden)
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 6)) { value in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                    AxisValueLabel {
                        if let coordinate = value.as(Double.self) {
                            let index = Int(coordinate.rounded())
                            if abs(coordinate - Double(index)) < 0.01, presentation.rows.indices.contains(index) {
                                Text(verbatim: axisLabel(index))
                            }
                        }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { _ in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
                    AxisValueLabel()
                }
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location): selected = row(at: location.x, proxy: proxy, geometry: geometry)
                            case .ended: if !focused { selected = nil }
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 0).onChanged { event in
                                focused = true
                                selected = row(at: event.location.x, proxy: proxy, geometry: geometry)
                            })
                }
            }.frame(height: 224).focusable().focused($focused).onKeyPress(phases: .down, action: move)
            .accessibilityLabel(strings.t("aiChat.toolResult"))
    }
    @ChartContentBuilder private func cartesianMark(index: Int, key: String, series: Int) -> some ChartContent {
        if let value = coordinate(AIChatToolPresentation.value(presentation.rows[index], key: key)) {
            if presentation.renderAs == .bar {
                barMark(index: index, key: key, series: series, value: value)
            } else {
                lineMark(index: index, key: key, series: series, value: value)
            }
        }
    }
    private func barMark(index: Int, key: String, series: Int, value: Double) -> some ChartContent {
        BarMark(x: .value(presentation.xKey, Double(index)), y: .value(key, value))
            .foregroundStyle(color(series)).position(by: .value("series", String(series)))
            .cornerRadius(4)
            .accessibilityLabel(axisLabel(index)).accessibilityValue(key + ": " + rawValue(index, key: key))
    }
    private func lineMark(index: Int, key: String, series: Int, value: Double) -> some ChartContent {
        let segmentKey = String(series) + ":" + String(segment(index, key: key))
        return LineMark(
            x: .value(presentation.xKey, Double(index)), y: .value(key, value),
            series: .value("series", segmentKey)
        )
        .foregroundStyle(color(series)).lineStyle(StrokeStyle(lineWidth: 2)).interpolationMethod(.monotone)
        .accessibilityLabel(axisLabel(index)).accessibilityValue(key + ": " + rawValue(index, key: key))
    }
    private var pie: some View {
        GeometryReader { geometry in
            let center = CGPoint(x: geometry.size.width / 2, y: geometry.size.height / 2)
            ZStack {
                if presentation.pieRenderable {
                    ForEach(presentation.pieRows) { row in
                        AIChatPieSector(start: row.startAngle, end: row.endAngle)
                            .fill(color(row.id)).frame(width: 160, height: 160).position(center)
                            .onHover { hovering in if hovering { selected = row.id } else if !focused { selected = nil }
                            }
                            .onTapGesture {
                                focused = true
                                selected = row.id
                            }
                            .accessibilityLabel(row.name).accessibilityValue(VisionFormat.plain(row.value))
                        let middle = -(row.startAngle + row.endAngle) / 2 * .pi / 180
                        let near = CGPoint(x: center.x + 80 * cos(middle), y: center.y + 80 * sin(middle))
                        let far = CGPoint(x: center.x + 102 * cos(middle), y: center.y + 102 * sin(middle))
                        Path { path in
                            path.move(to: near)
                            path.addLine(to: far)
                        }.stroke(color(row.id), lineWidth: 1).accessibilityHidden(true)
                        Text(
                            verbatim: row.name + " "
                                + VisionFormat.percent(
                                    row.labelPercent, digits: 0, locale: shell.settings.numberFormat.locale)
                        )
                        .font(.caption).foregroundStyle(color(row.id))
                        .position(x: far.x + (cos(middle) >= 0 ? 34 : -34), y: far.y).accessibilityHidden(true)
                    }
                }
            }
        }.frame(height: 224).focusable().focused($focused).onKeyPress(phases: .down, action: move)
            .accessibilityLabel(strings.t("aiChat.toolResult"))
    }
    @ViewBuilder private func readout(_ index: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if presentation.renderAs == .pie {
                if let row = presentation.pieRows.first(where: { $0.id == index }) {
                    Text(verbatim: row.name).font(.caption.weight(.medium))
                    Text(verbatim: VisionFormat.plain(row.value)).font(.caption).monospacedDigit()
                }
            } else if presentation.rows.indices.contains(index) {
                Text(verbatim: axisLabel(index)).font(.caption.weight(.medium))
                ForEach(Array(presentation.yKeys.enumerated()), id: \.offset) { series, key in
                    if let value = AIChatToolPresentation.value(presentation.rows[index], key: key), value != .null {
                        HStack(spacing: 6) {
                            Circle().fill(color(series)).frame(width: 6, height: 6)
                            Text(verbatim: key + ": " + rawValue(index, key: key)).font(.caption).monospacedDigit()
                        }
                    }
                }
            }
        }.padding(8).frame(maxWidth: .infinity, alignment: .leading).background(
            theme.muted, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
    }
    private func axisLabel(_ index: Int) -> String {
        AIChatToolDisplay.axis(AIChatToolPresentation.value(presentation.rows[index], key: presentation.xKey))
    }
    private func rawValue(_ index: Int, key: String) -> String {
        let value = AIChatToolPresentation.value(presentation.rows[index], key: key)
        return value.map(AIChatText.javascriptString) ?? ""
    }
    private func segment(_ index: Int, key: String) -> Int {
        presentation.rows.prefix(index).filter { coordinate(AIChatToolPresentation.value($0, key: key)) == nil }.count
    }
    private func coordinate(_ value: TaxValue?) -> Double? {
        if let decimal = value?.decimalValue { return NSDecimalNumber(decimal: decimal).doubleValue }
        if let string = value?.stringValue, let number = Double(string), number.isFinite { return number }
        return nil
    }
    private func row(at x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) -> Int? {
        guard let frame = proxy.plotFrame else { return nil }
        let plot = geometry[frame]
        guard x >= plot.minX && x <= plot.maxX, let value = proxy.value(atX: x - plot.minX, as: Double.self) else {
            return nil
        }
        let index = Int(value.rounded())
        return presentation.rows.indices.contains(index) ? index : nil
    }
    private func move(_ press: KeyPress) -> KeyPress.Result {
        let count = presentation.renderAs == .pie ? presentation.pieRows.count : presentation.rows.count
        guard count > 0 else { return .ignored }
        switch press.key {
        case .leftArrow, .upArrow: selected = max(0, (selected ?? count) - 1)
        case .rightArrow, .downArrow: selected = min(count - 1, (selected ?? -1) + 1)
        case .home: selected = 0
        case .end: selected = count - 1
        case .escape: selected = nil
        default: return .ignored
        }
        return .handled
    }
}

private struct AIChatPieSector: Shape {
    let start: Double
    let end: Double
    func path(in rect: CGRect) -> Path {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        let outer = min(rect.width, rect.height) / 2
        let inner = outer / 2
        // Recharts Sector caps a displayed arc just below a full revolution.
        let span = (end >= start ? 1.0 : -1.0) * min(abs(end - start), 359.999)
        let drawingEnd = start + span
        var path = Path()
        path.addArc(
            center: center, radius: outer, startAngle: .degrees(-start), endAngle: .degrees(-drawingEnd),
            clockwise: end >= start)
        path.addArc(
            center: center, radius: inner, startAngle: .degrees(-drawingEnd), endAngle: .degrees(-start),
            clockwise: end < start)
        path.closeSubpath()
        return path
    }
}
