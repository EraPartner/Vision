import Charts
import SwiftUI
import VisionNativeCore

/// Shared native chart interaction: hover, drag range comparison, and keyboard month/day
/// walking. Readouts use the original Decimal values; Double is only a plot coordinate.
struct InsightTimelineChart: View {
    let series: [InsightChartSeries]
    let currency: String
    let settings: NativeAppSettings
    let title: String
    var bars = false
    var areas = false
    var stackedBars = false
    var stackedAreas = true
    var rangeComparison = true
    var height: CGFloat = 240
    var customColors: [String: Color] = [:]
    var areaSeries: Set<String>? = nil
    var rangePercent = false
    var formatPeriod: ((String) -> String)? = nil
    var formatTick: ((String) -> String)? = nil
    @Binding var selection: String?
    @Binding var rangeStart: String?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    @Environment(\.locale) private var locale

    private var keys: [String] { Array(Set(series.flatMap { $0.points.map(\.key) })).sorted() }
    private var colors: [Color] {
        let palette = theme.palette
        return [
            Color(token: palette.chart1), Color(token: palette.chart2), Color(token: palette.chart3),
            Color(token: palette.chart4), Color(token: palette.chart5), Color(token: palette.chart6),
            Color(token: palette.chart7), Color(token: palette.chart8),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Chart {
                ForEach(series) { line in
                    ForEach(line.points) { point in
                        if bars && !line.dashed {
                            if stackedBars {
                                BarMark(x: .value(title, point.key), y: .value(line.label, coordinate(point.value)))
                                    .foregroundStyle(by: .value(title, line.label))
                            } else {
                                BarMark(x: .value(title, point.key), y: .value(line.label, coordinate(point.value)))
                                    .foregroundStyle(by: .value(title, line.label))
                                    .position(by: .value(title, line.label))
                            }
                        } else if areas && (areaSeries?.contains(line.id) ?? true)
                            && (!stackedAreas || !series.contains(where: { $0.points.contains { $0.value < 0 } }))
                        {
                            AreaMark(
                                x: .value(title, point.key), y: .value(line.label, coordinate(point.value)),
                                stacking: stackedAreas ? .standard : .unstacked
                            )
                            .foregroundStyle(by: .value(title, line.label))
                            .opacity(areaSeries == nil ? 1 : 0.12)
                            if areaSeries != nil {
                                LineMark(
                                    x: .value(title, point.key), y: .value(line.label, coordinate(point.value)),
                                    series: .value(title, line.id)
                                )
                                .foregroundStyle(by: .value(title, line.label))
                                .lineStyle(StrokeStyle(lineWidth: 2.5))
                            }
                        } else {
                            LineMark(
                                x: .value(title, point.key), y: .value(line.label, coordinate(point.value)),
                                series: .value(title, line.id)
                            )
                            .foregroundStyle(by: .value(title, line.label))
                            .lineStyle(
                                StrokeStyle(
                                    lineWidth: line.id == "actual" ? 2.5 : 1.5,
                                    dash: line.dashed ? [5, 4] : []))
                        }
                    }
                }
                if let selection, keys.contains(selection) {
                    RuleMark(x: .value(title, selection)).foregroundStyle(
                        theme.secondaryLabel.opacity(0.5))
                }
                if let rangeStart, let selection, keys.contains(rangeStart), keys.contains(selection) {
                    RectangleMark(
                        xStart: .value(title, min(rangeStart, selection)),
                        xEnd: .value(title, max(rangeStart, selection))
                    )
                    .foregroundStyle(theme.primary.opacity(0.08))
                }
            }
            .chartForegroundStyleScale(
                domain: series.map(\.label), range: series.indices.map { seriesColor(at: $0) }
            )
            .chartXScale(domain: keys)
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 6)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let key = value.as(String.self) { Text(formatTick?(key) ?? periodLabel(key)) }
                    }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let number = value.as(Double.self) {
                            Text(
                                VisionFormat.currency(
                                    Decimal(number), code: currency,
                                    locale: settings.numberFormat.locale, fractionDigits: 0))
                        }
                    }
                }
            }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                selection = key(at: location.x, proxy: proxy, geometry: geometry)
                            case .ended: if rangeStart == nil { selection = nil }
                            }
                        }
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { drag in
                                    focused = true
                                    if rangeComparison && rangeStart == nil {
                                        rangeStart = key(at: drag.startLocation.x, proxy: proxy, geometry: geometry)
                                    }
                                    selection = key(at: drag.location.x, proxy: proxy, geometry: geometry)
                                }.onEnded { _ in
                                    if !rangeComparison {
                                        selection = nil
                                        rangeStart = nil
                                    }
                                })
                }
            }
            .frame(height: height)
            .focusable().focused($focused).focusEffectDisabled()
            .onKeyPress(phases: .down, action: handleKey)
            .onChange(of: focused) { _, value in
                if !value {
                    selection = nil
                    rangeStart = nil
                }
            }
            .accessibilityLabel(title)
            if let selection {
                VStack(alignment: .leading, spacing: 3) {
                    Text(rangeStart.map { "\(periodLabel($0)) – \(periodLabel(selection))" } ?? periodLabel(selection))
                        .font(
                            .caption.weight(.medium))
                    ForEach(series) { line in
                        if let value = line.points.first(where: { $0.key == selection })?.value {
                            HStack {
                                Text(line.label).foregroundStyle(theme.secondaryLabel)
                                Spacer()
                                MoneyText(
                                    amount: value, currency: currency, settings: settings, signed: false,
                                    colored: false)
                                if let rangeStart,
                                    let start = line.points.first(where: { $0.key == rangeStart })?.value
                                {
                                    Text("Δ").accessibilityHidden(true)
                                    if rangePercent {
                                        Text(MoneyText.text(value - start, currency: currency, settings: settings))
                                            .monospacedDigit().foregroundStyle(value < start ? theme.loss : theme.gain)
                                    } else {
                                        MoneyText(amount: value - start, currency: currency, settings: settings)
                                    }
                                    if rangePercent, start != 0 {
                                        Text(
                                            ((value - start) > 0 ? "+" : "")
                                                + VisionFormat.percent(
                                                    (value - start) / abs(start) * 100,
                                                    locale: settings.numberFormat.locale))
                                    }
                                }
                            }.font(.caption)
                        }
                    }
                }
                .padding(8).background(
                    theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: 8)
                )
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func periodLabel(_ key: String) -> String {
        if let formatPeriod { return formatPeriod(key) }
        let parts = key.split(separator: "-")
        guard parts.count == 2, let year = Int(parts[0]), let month = Int(parts[1]),
            let date = Calendar.current.date(from: DateComponents(year: year, month: month, day: 1))
        else { return key }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.dateFormat = "MMM yyyy"
        return formatter.string(from: date)
    }
    private func coordinate(_ value: Decimal) -> Double {
        NSDecimalNumber(decimal: value).doubleValue
    }
    private func seriesColor(at index: Int) -> Color {
        let line = series[index]
        if let color = customColors[line.id] { return color }
        let id = line.id.components(separatedBy: "__").first ?? line.id
        if id == "actual" { return theme.primary }
        if id == "income" { return theme.gain }
        if id == "spending" { return theme.loss }
        if id == "net" { return (line.points.last?.value ?? 0) < 0 ? theme.loss : theme.gain }
        let methods = [
            "simple_avg": 0, "weighted_avg": 1, "ewma": 2, "holt_winters": 3,
            "prophet_lite": 4, "monte_carlo_parametric": 5, "monte_carlo_block_bootstrap": 6, "ensemble_imse": 7,
        ]
        return colors[(methods[id] ?? index) % colors.count]
    }
    private func key(at x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) -> String? {
        guard let plot = proxy.plotFrame else { return nil }
        let frame = geometry[plot]
        return proxy.value(atX: min(max(0, x - frame.minX), frame.width), as: String.self)
    }
    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        guard !keys.isEmpty else { return .ignored }
        let current = selection.flatMap(keys.firstIndex) ?? keys.count - 1
        let next: Int
        if press.key == .leftArrow {
            next = max(0, current - 1)
        } else if press.key == .rightArrow {
            next = min(keys.count - 1, current + 1)
        } else if press.characters == "\u{F729}" {
            next = 0
        } else if press.characters == "\u{F72B}" {
            next = keys.count - 1
        } else if press.key == .escape {
            selection = nil
            rangeStart = nil
            return .handled
        } else {
            return .ignored
        }
        if rangeComparison, press.modifiers.contains(.shift), rangeStart == nil {
            rangeStart = keys[current]
        } else if !press.modifiers.contains(.shift) {
            rangeStart = nil
        }
        selection = keys[next]
        return .handled
    }
}

struct HomeCategoryChart: View {
    let slices: [HomeCategorySlice]
    let strings: any Localizing
    let navigate: (String) -> Void
    @State private var selectedCount: Int?
    @State private var selectedId: String?
    @Environment(\.visionTheme) private var theme

    private var selected: HomeCategorySlice? { slices.first { $0.id == selectedId } }
    var body: some View {
        VStack(spacing: 12) {
            if slices.isEmpty {
                Text(strings.t("categoryPie.noData")).foregroundStyle(theme.secondaryLabel).frame(
                    height: 240)
            } else {
                Chart(slices) { slice in
                    SectorMark(
                        angle: .value(slice.name, slice.count), innerRadius: .ratio(0.6),
                        outerRadius: .ratio(selectedId == slice.id ? 1 : 0.93), angularInset: 2
                    )
                    .foregroundStyle(by: .value(strings.t("categories.title"), slice.name))
                    .accessibilityLabel(slice.name).accessibilityValue(String(slice.count))
                }
                .chartAngleSelection(value: $selectedCount)
                .chartForegroundStyleScale(
                    domain: slices.map(\.name),
                    range: slices.map { slice in
                        let palette = theme.palette
                        let colors = [
                            palette.chart1, palette.chart2, palette.chart3, palette.chart4,
                            palette.chart5, palette.chart6, palette.chart7, palette.chart8,
                        ]
                        let root =
                            slice.name.split(separator: ":").first.map(String.init)?.trimmingCharacters(
                                in: .whitespaces
                            ).uppercased() ?? ""
                        var hash: Int32 = 0
                        for scalar in root.utf16 { hash = hash &* 31 &+ Int32(scalar) }
                        return Color(token: colors[Int(abs(Int64(hash)) % 8)])
                    }
                )
                .chartLegend(position: .bottom)
                .chartBackground { _ in
                    VStack(spacing: 4) {
                        Text(selected?.name ?? strings.t("categoryPie.title")).font(.caption)
                            .multilineTextAlignment(.center)
                        Text(String(selected?.count ?? slices.reduce(0) { $0 + $1.count })).font(
                            .title2.monospacedDigit())
                    }.frame(maxWidth: 120)
                }
                .frame(height: 232)
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Rectangle().fill(.clear).contentShape(Rectangle())
                            .onContinuousHover { phase in
                                switch phase {
                                case .active(let location):
                                    selectedId = slice(at: location, proxy: proxy, geometry: geometry)?.id
                                case .ended: selectedId = nil
                                }
                            }
                            .gesture(
                                SpatialTapGesture().onEnded { tap in
                                    if let slice = slice(at: tap.location, proxy: proxy, geometry: geometry) {
                                        navigate(slice.route.string)
                                    }
                                })
                    }
                }
                .onChange(of: selectedCount) { _, value in
                    guard let value else {
                        selectedId = nil
                        return
                    }
                    var count = 0
                    selectedId =
                        slices.first { slice in
                            count += slice.count
                            return value < count
                        }?.id
                }
                // Native buttons preserve an accessible and keyboard-operable link for every slice.
                HStack {
                    ForEach(slices) { slice in
                        Button(slice.name) { navigate(slice.route.string) }
                            .buttonStyle(.link).font(.caption)
                    }
                }
                if let selected {
                    Button(selected.name) { navigate(selected.route.string) }.buttonStyle(.bordered)
                }
            }
        }
    }
    private func slice(at point: CGPoint, proxy: ChartProxy, geometry: GeometryProxy)
        -> HomeCategorySlice?
    {
        guard let plot = proxy.plotFrame else { return nil }
        let frame = geometry[plot]
        let dx = point.x - frame.midX
        let dy = point.y - frame.midY
        let radius = min(frame.width, frame.height) / 2
        let distance = hypot(dx, dy)
        guard distance >= radius * 0.6, distance <= radius else { return nil }
        var angle = atan2(dx, -dy)
        if angle < 0 { angle += 2 * .pi }
        let total = slices.reduce(0) { $0 + $1.count }
        let position = angle / (2 * .pi) * CGFloat(total)
        var end = 0
        return slices.first { slice in
            end += slice.count
            return position < CGFloat(end)
        }
    }
}
