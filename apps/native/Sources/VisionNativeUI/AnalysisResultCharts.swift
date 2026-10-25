import SwiftUI
import VisionNativeCore

struct AnalysisResultCharts: View {
    let result: AnalysisResult
    @Binding var spec: TaxValue
    let shell: NativeShellModel
    var labels: [String: String] = [:]
    @State private var selected: Int?
    @State private var tableExpanded = false
    @Environment(\.visionTheme) private var theme
    private var strings: any Localizing { shell.strings }
    private var columns: [AnalysisColumn] {
        result.declaredColumns?.isEmpty == false ? result.declaredColumns! : result.columns
    }
    private var kind: String {
        let value = spec["kind"]?.stringValue ?? ""
        return ["bar", "line", "stacked-bar", "scatter", "waterfall"].contains(value) ? value : "bar"
    }
    private var xID: String { spec["x"]?.stringValue ?? "" }
    private var yIDs: [String] {
        let values = spec["y"]?.arrayValue?.compactMap(\.stringValue) ?? spec["y"]?.stringValue.map { [$0] } ?? []
        return values.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
    }
    private var points: [Point] {
        result.rows.enumerated().map { index, row in
            Point(
                index: index, label: AnalysisPresentation.rawText(row[xID]), x: coordinate(row[xID]),
                values: yIDs.map { coordinate(row[$0]) }, raw: row)
        }
    }
    private var omitted: Int { points.filter { $0.values.contains(nil) || (kind == "scatter" && $0.x == nil) }.count }
    private var unavailable: String? {
        if !AnalysisPresentation.isComplete(result.raw) { return "analysis.ext.chart.complete" }
        if !AnalysisPresentation.compatibleChartUnits(result: result.raw, series: yIDs) {
            return "analysis.ext.chart.units"
        }
        if xID.isEmpty || yIDs.isEmpty { return "analysis.ext.chart.select" }
        if kind == "waterfall" && omitted > 0 { return "analysis.ext.chart.waterfallMissing" }
        if kind == "waterfall" && yIDs.count != 1 { return "analysis.ext.chart.oneSeries" }
        if points.isEmpty { return "analysis.ext.chart.empty" }
        return nil
    }
    private var xOptions: [VisionSelectOption<String>] {
        var options = [VisionSelectOption(value: "", title: "—")]
        for column in columns { options.append(VisionSelectOption(value: column.id, title: label(column.id))) }
        return options
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VisionSegmentedControl(
                selection: Binding(get: { kind }, set: { spec["kind"] = .string($0) }),
                values: ["bar", "line", "stacked-bar", "scatter", "waterfall"],
                title: { strings.t("analysis.ext.chart.\($0)") }, label: strings.t("analysis.ext.chart.type"))
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t("analysis.ext.chart.x")).font(.callout.weight(.medium))
                VisionSelect(
                    selection: Binding(get: { xID }, set: { spec["x"] = .string($0) }), options: xOptions,
                    accessibilityLabel: strings.t("analysis.ext.chart.x"), expands: true)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(strings.t("analysis.ext.chart.series")).font(.callout.weight(.medium))
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150))], alignment: .leading) {
                    ForEach(columns.filter { AnalysisPresentation.isNumeric($0.type) }) { column in
                        Toggle(
                            label(column.id),
                            isOn: Binding(
                                get: { yIDs.contains(column.id) },
                                set: { on in
                                    spec["y"] = .array(
                                        (on ? yIDs + [column.id] : yIDs.filter { $0 != column.id }).map(TaxValue.string)
                                    )
                                })
                        ).toggleStyle(.visionCheckbox)
                    }
                }
            }
            if let unavailable {
                Text(strings.t(unavailable)).font(.callout).foregroundStyle(theme.secondaryLabel)
            } else {
                Text(
                    strings.t(
                        "analysis.ext.chart.coverage", ["rows": String(points.count), "missing": String(omitted)])
                )
                .font(.caption).foregroundStyle(theme.secondaryLabel)
                canvas
                if let selected, points.indices.contains(selected) {
                    Text(readout(points[selected])).font(.caption).monospacedDigit().textSelection(.enabled)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                HStack(spacing: 18) {
                    ForEach(Array(yIDs.enumerated()), id: \.element) { index, id in
                        Label(seriesLabel(id), systemImage: "circle.fill").font(.caption).foregroundStyle(color(index))
                    }
                }
                DisclosureGroup(strings.t("analysis.ext.chart.table"), isExpanded: $tableExpanded) {
                    ScrollView(.horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                            GridRow {
                                Text(seriesLabel(xID))
                                ForEach(yIDs, id: \.self) { Text(seriesLabel($0)) }
                            }.fontWeight(.medium)
                            ForEach(points) { point in
                                GridRow {
                                    Text(verbatim: formatted(point.raw[xID], id: xID))
                                    ForEach(yIDs, id: \.self) { Text(verbatim: formatted(point.raw[$0], id: $0)) }
                                }
                            }
                        }.font(.caption).monospacedDigit().textSelection(.enabled).padding(.top, 10)
                    }
                }
            }
        }.onChange(of: spec) { selected = nil }.onChange(of: result) { selected = nil }
    }
    private var canvas: some View {
        GeometryReader { geometry in
            let model = Drawing(points: points, kind: kind, seriesCount: yIDs.count, size: geometry.size)
            Canvas { context, _ in
                for step in 0...4 {
                    let value = model.minimum + model.span * Double(step) / 4
                    let y = model.y(value)
                    var line = Path()
                    line.move(to: CGPoint(x: model.left, y: y))
                    line.addLine(to: CGPoint(x: model.right, y: y))
                    context.stroke(line, with: .color(theme.border.opacity(0.5)), lineWidth: 1)
                    let tick = Text(tick(value)).font(.caption2).foregroundColor(theme.secondaryLabel)
                    context.draw(tick, at: CGPoint(x: model.left - 8, y: y), anchor: .trailing)
                }
                var zero = Path()
                zero.move(to: CGPoint(x: model.left, y: model.y(0)))
                zero.addLine(to: CGPoint(x: model.right, y: model.y(0)))
                context.stroke(zero, with: .color(theme.foreground.opacity(0.4)), lineWidth: 1)
                for index in yIDs.indices {
                    if kind == "line" {
                        var line = Path()
                        var started = false
                        for point in points {
                            guard let value = point.values[index] else {
                                started = false
                                continue
                            }
                            let coordinate = CGPoint(x: model.x(point), y: model.y(value))
                            if started {
                                line.addLine(to: coordinate)
                            } else {
                                line.move(to: coordinate)
                                started = true
                            }
                        }
                        context.stroke(line, with: .color(color(index)), lineWidth: 2)
                    } else {
                        for point in points {
                            guard let value = point.values[index], kind != "scatter" || point.x != nil,
                                kind != "waterfall" || index == 0
                            else { continue }
                            if kind == "scatter" {
                                let rect = CGRect(x: model.x(point) - 4, y: model.y(value) - 4, width: 8, height: 8)
                                context.fill(Path(ellipseIn: rect), with: .color(color(index)))
                            } else {
                                let ends = model.ends[point.index][index]
                                let barWidth =
                                    kind == "bar" ? model.step * 0.72 / Double(max(1, yIDs.count)) : model.step * 0.72
                                let originX =
                                    model.x(point) - model.step * 0.36 + (kind == "bar" ? Double(index) * barWidth : 0)
                                let rect = CGRect(
                                    x: originX, y: min(model.y(ends.0), model.y(ends.1)), width: max(1, barWidth),
                                    height: abs(model.y(ends.0) - model.y(ends.1)))
                                context.fill(
                                    Path(rect),
                                    with: .color(
                                        kind == "waterfall" ? (value < 0 ? theme.loss : theme.gain) : color(index)))
                            }
                        }
                    }
                }
                for point in points where point.index % max(1, Int(ceil(Double(points.count) / 10))) == 0 {
                    if kind != "scatter" || point.x != nil {
                        context.draw(
                            Text(String(formatted(point.raw[xID], id: xID).prefix(20))).font(.caption2).foregroundStyle(
                                theme.secondaryLabel),
                            at: CGPoint(x: model.x(point), y: model.bottom + 20), anchor: .top)
                    }
                }
            }.onContinuousHover { phase in
                switch phase {
                case .active(let position):
                    selected =
                        points.filter { kind != "scatter" || $0.x != nil }
                        .min { abs(model.x($0) - position.x) < abs(model.x($1) - position.x) }?.index
                case .ended: selected = nil
                }
            }.focusable().onKeyPress(phases: .down) { key in
                if key.key == .leftArrow {
                    selected = max(0, (selected ?? 0) - 1)
                } else if key.key == .rightArrow {
                    selected = min(points.count - 1, (selected ?? -1) + 1)
                } else if key.characters == "\u{F729}" {
                    selected = 0
                } else if key.characters == "\u{F72B}" {
                    selected = points.count - 1
                } else if key.key == .escape {
                    selected = nil
                } else {
                    return .ignored
                }
                if let selected { AccessibilityNotification.Announcement(readout(points[selected])).post() }
                return .handled
            }.accessibilityLabel(strings.t("analysis.ext.chart.\(kind)"))
                .accessibilityValue(selected.flatMap { points.indices.contains($0) ? readout(points[$0]) : nil } ?? "")
        }.frame(height: 330)
    }
    private func readout(_ point: Point) -> String {
        "\(formatted(point.raw[xID], id: xID)): "
            + yIDs.map { "\(seriesLabel($0)) \(formatted(point.raw[$0], id: $0))" }.joined(separator: "; ")
    }
    private func label(_ id: String) -> String { labels[id] ?? columns.first { $0.id == id }?.label ?? id }
    private func seriesLabel(_ id: String) -> String {
        guard let unit = columns.first(where: { $0.id == id })?.unit else { return label(id) }
        let kinds = ["money", "quantity", "ratio", "number", "dimensionless", "currency"]
        let optionKey = "analysis.ext.workbench.option.\(unit.kind)"
        let option = strings.t(optionKey)
        let kind =
            kinds.contains(unit.kind)
            ? strings.t("analysis.ext.chart.unit.\(unit.kind)") : option == optionKey ? unit.kind : option
        let currency =
            unit.currency ?? unit.currencyColumn.map { AnalysisPresentation.rawText(result.rows.first?[$0]) } ?? ""
        return "\(label(id)) (\([kind, currency].filter { !$0.isEmpty }.joined(separator: " ")))"
    }
    private func formatted(_ value: TaxValue?, id: String) -> String {
        let type = columns.first { $0.id == id }?.type ?? "string"
        if type == "date", let raw = value?.stringValue {
            let parts = raw.split(separator: "-").compactMap { Int($0) }
            if raw.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil, parts.count == 3 {
                return PlannedDay(year: parts[0], month: parts[1], day: parts[2]).text(
                    format: shell.settings.dateFormat)
            }
        }
        return AnalysisPresentation.format(
            value: value, type: type, id: id, numberFormat: shell.settings.numberFormat.rawValue)
    }
    private func color(_ index: Int) -> Color {
        let p = theme.palette
        return Color(token: [p.chart1, p.chart2, p.chart3, p.chart4, p.chart5][index % 5])
    }
    private func tick(_ value: Double) -> String {
        let locale = shell.settings.numberFormat.locale
        let formatter = FormatterCache.shared("analysis.tick|\(locale.identifier)") {
            () -> NumberFormatter in
            let made = NumberFormatter()
            made.locale = locale
            made.numberStyle = .decimal
            made.usesSignificantDigits = true
            made.maximumSignificantDigits = 5
            return made
        }
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }
    private func coordinate(_ raw: TaxValue?) -> Double? {
        guard let raw, raw != .null, raw.boolValue == nil, raw != .string("") else { return nil }
        let text = AnalysisPresentation.rawText(raw).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return 0 }
        for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] where text.lowercased().hasPrefix(prefix) {
            let digits = text.dropFirst(2)
            guard !digits.isEmpty else { return nil }
            var value = 0.0
            for character in digits {
                guard let digit = Int(String(character), radix: radix) else { return nil }
                value = value * Double(radix) + Double(digit)
            }
            return value.isFinite ? value : nil
        }
        guard
            text.range(of: #"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$"#, options: .regularExpression)
                != nil,
            let value = Double(text), value.isFinite
        else { return nil }
        return value
    }
    private struct Point: Identifiable {
        let index: Int
        let label: String
        let x: Double?
        let values: [Double?]
        let raw: AnalysisRow
        var id: Int { index }
    }
    /// These Double sums only position drawn segments. No sum is exposed as a financial value.
    private struct Drawing {
        let points: [Point]
        let kind: String
        let size: CGSize
        let ends: [[(Double, Double)]]
        let minimum: Double
        let span: Double
        let xmin: Double
        let xspan: Double
        var left: Double { 75 }
        var right: Double { max(76, size.width - 20) }
        var bottom: Double { max(21, size.height - 60) }
        var step: Double { (right - left) / Double(max(1, points.count)) }
        init(points: [Point], kind: String, seriesCount: Int, size: CGSize) {
            self.points = points
            self.kind = kind
            self.size = size
            var cumulative = 0.0
            ends = points.map { point in
                var positive = 0.0
                var negative = 0.0
                return point.values.map { optional in
                    let value = optional ?? 0
                    if kind == "waterfall" {
                        let start = cumulative
                        cumulative += value
                        return (start, cumulative)
                    }
                    if kind == "stacked-bar" {
                        if value >= 0 {
                            let start = positive
                            positive += value
                            return (start, positive)
                        }
                        let start = negative
                        negative += value
                        return (start, negative)
                    }
                    return (0, value)
                }
            }
            let domain = ends.flatMap { $0.flatMap { [$0.0, $0.1] } }
            minimum = min(0, domain.min() ?? 0)
            let maximum = max(0, domain.max() ?? 0)
            span = maximum - minimum == 0 ? 1 : maximum - minimum
            let xs = points.compactMap(\.x)
            xmin = xs.min() ?? 0
            let xmax = xs.max() ?? 0
            xspan = xmax - xmin == 0 ? 1 : xmax - xmin
        }
        func y(_ value: Double) -> Double { 20 + ((minimum + span - value) / span) * (bottom - 20) }
        func x(_ point: Point) -> Double {
            kind == "scatter"
                ? left + ((point.x ?? xmin) - xmin) / xspan * (right - left) : left + step * (Double(point.index) + 0.5)
        }
    }
}
