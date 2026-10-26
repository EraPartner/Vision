import Charts
import SwiftUI
import VisionNativeCore

/// How a timeline chart writes its value-axis ticks: `formatAxisCompact` ("6,5k €") or the full
/// currency format with the app's decimal places (`formatCurrency`).
enum InsightYAxisFormat { case compact, full }

/// How a timeline chart writes its x-axis ticks: `CHART_DATE_PATTERNS.monthTick` ("Nov 24"),
/// `formatMonthYearWithAppSettings` ("05/2026"), the day number of a month ("2", "4", ...) or
/// `CHART_DATE_PATTERNS.dayTick` ("2 Nov").
enum InsightXLabels { case shortMonth, appMonthYear, dayOfMonth, dayMonth }

/// Shared native chart interaction: hover, drag range comparison, and keyboard month/day
/// walking. Readouts use the original Decimal values; Double is only a plot coordinate.
struct InsightTimelineChart: View {
    let series: [InsightChartSeries]
    let currency: CurrencyCode
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
    /// Legend position. `nil` follows the web: above the plot when there is more than one series.
    var legend: ChartLegendPlacement? = nil
    /// Series ids in the order the legend lists them; unlisted series follow in series order.
    var legendOrder: [String] = []
    var yAxis: InsightYAxisFormat = .compact
    var xLabels: InsightXLabels = .shortMonth
    /// The dashed zero reference line (`referenceLines={[{ y: 0, dashed: true }]}`).
    var zeroLine = false
    /// A bare `Sparkline`: no axes or legend, a smoothed line over a flat 15 % fill, the value
    /// range padded by 10 % and not niced.
    var sparkline = false
    @Binding var selection: String?
    @Binding var rangeStart: String?
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    /// The sorted keys and their positions and the lines thinned for drawing, rebuilt only when
    /// the series change (a hover re-renders this view with the same series, and every pointer
    /// move asks for the keys).
    @State private var plotCache = ChartSeriesPlotCache()
    /// Month names follow the app language (web `appLanguageToLocale`), never the environment
    /// locale, which several hosts set to the number-format locale for digits.
    private var locale: Locale {
        LanguageLocale.locale(NativeLanguage(rawValue: settings.language.rawValue) ?? .en)
    }

    /// Stacked areas share their x positions after thinning, so they still stack.
    private var plot: ChartSeriesPlot { plotCache.plot(for: series, shared: areas && stackedAreas) }
    private var keys: [String] { plot.layout.keys }
    private var colors: [Color] {
        let palette = theme.palette
        return [
            Color(token: palette.chart1), Color(token: palette.chart2), Color(token: palette.chart3),
            Color(token: palette.chart4), Color(token: palette.chart5), Color(token: palette.chart6),
            Color(token: palette.chart7), Color(token: palette.chart8),
        ]
    }

    /// Each key's position on a quantitative x axis. A String-keyed (categorical) axis
    /// labels every category whatever tick values it is given, so 24 months or a daily
    /// forecast drew overlapping dates.
    private var keyIndex: [String: Int] { plot.layout.index }
    private var barSeries: [InsightChartSeries] { bars ? series.filter { !$0.dashed } : [] }

    /// One bar: drawn as a rectangle so grouped and stacked bars keep a band layout on the
    /// quantitative axis (0.8 of each index step, like the categorical band they replace).
    private struct BarRect: Identifiable {
        let id: String
        let label: String
        let x0: Double
        let x1: Double
        let y0: Double
        let y1: Double
    }

    private var barRects: [BarRect] {
        let index = keyIndex
        let lines = barSeries
        guard !lines.isEmpty else { return [] }
        var rects: [BarRect] = []
        if stackedBars {
            var positive: [Int: Double] = [:]
            var negative: [Int: Double] = [:]
            for line in lines {
                for point in line.points {
                    guard let i = index[point.key] else { continue }
                    let value = coordinate(point.value)
                    let base = value < 0 ? negative[i, default: 0] : positive[i, default: 0]
                    let top = base + value
                    if value < 0 { negative[i] = top } else { positive[i] = top }
                    rects.append(
                        BarRect(
                            id: line.id + "|" + point.key, label: line.label, x0: Double(i) - 0.36,
                            x1: Double(i) + 0.36, y0: base, y1: top))
                }
            }
        } else {
            let width = 0.72 / Double(lines.count)
            for (offset, line) in lines.enumerated() {
                for point in line.points {
                    guard let i = index[point.key] else { continue }
                    let x0 = Double(i) - 0.36 + Double(offset) * width
                    rects.append(
                        BarRect(
                            id: line.id + "|" + point.key, label: line.label, x0: x0 + width * 0.06,
                            x1: x0 + width * 0.94, y0: 0, y1: coordinate(point.value)))
                }
            }
        }
        return rects
    }

    private var xDomain: ClosedRange<Double> {
        bars ? -0.5...(Double(max(keys.count, 1)) - 0.5) : 0...Double(max(keys.count - 1, 1))
    }

    private var hasNegativeValue: Bool { series.contains { $0.points.contains { $0.value < 0 } } }
    /// Stacked areas stack only while no value is negative (the web's `stacked={!hasNegative}`).
    private var stacksAreas: Bool { areas && stackedAreas && !hasNegativeValue }
    private func drawsArea(_ line: InsightChartSeries) -> Bool {
        areas && !(bars && !line.dashed) && (areaSeries?.contains(line.id) ?? true)
    }
    private func lineColor(_ line: InsightChartSeries) -> Color {
        seriesColor(at: series.firstIndex { $0.id == line.id } ?? 0)
    }

    /// The web chart's value domain: bars keep the baseline in view, stacked areas run from the
    /// lowest total to the highest, everything else is fitted to the data (not zero-based).
    private var yDomain: ClosedRange<Double> {
        if sparkline {
            let values = series.flatMap { $0.points.map { coordinate($0.value) } }
            let low = values.min() ?? 0
            let high = values.max() ?? 1
            let pad = high != low ? (high - low) * 0.1 : 1
            return (low - pad)...(high + pad)
        }
        let rects = barRects
        if !rects.isEmpty {
            let overlays = series.filter(\.dashed).flatMap { $0.points.map { coordinate($0.value) } }
            return ChartAxisTicks.zeroBasedDomain(rects.flatMap { [$0.y0, $0.y1] } + overlays)
        }
        if stacksAreas {
            var totals: [String: Double] = [:]
            for line in series where drawsArea(line) {
                for point in line.points { totals[point.key, default: 0] += coordinate(point.value) }
            }
            let values = Array(totals.values)
            return ChartAxisTicks.niceDomain(min(0, values.min() ?? 0), max(values.max() ?? 1, 1e-9))
        }
        var values = series.flatMap { $0.points.map { coordinate($0.value) } }
        if zeroLine { values.append(0) }
        return ChartAxisTicks.fittedDomain(values)
    }

    private var legendPlacement: ChartLegendPlacement {
        sparkline ? .hidden : legend ?? (series.count > 1 ? .top : .hidden)
    }
    private func areaStyle(_ line: InsightChartSeries) -> AnyShapeStyle {
        sparkline
            ? AnyShapeStyle(lineColor(line).opacity(0.15)) : AnyShapeStyle(ChartFill.areaGradient(lineColor(line)))
    }
    private var legendItems: [ChartLegendItem] {
        let items = series.indices.map { position in
            ChartLegendItem(
                id: series[position].id, label: series[position].label, color: seriesColor(at: position),
                dashed: series[position].dashed)
        }
        guard !legendOrder.isEmpty else { return items }
        let rank = Dictionary(uniqueKeysWithValues: legendOrder.enumerated().map { ($1, $0) })
        return items.enumerated()
            .sorted { (rank[$0.element.id] ?? Int.max, $0.offset) < (rank[$1.element.id] ?? Int.max, $1.offset) }
            .map(\.element)
    }

    /// Where the x axis draws its labels: day numbers every other day for a month's forecast,
    /// otherwise evenly spread (every month of a short bar chart, six to eight on a long line).
    private var xTickPositions: [Double] {
        if xLabels == .dayOfMonth {
            let days = keys.compactMap { $0.split(separator: "-").last.flatMap { Int($0) } }
            if days.count == keys.count, let positions = ChartAxisTicks.dayOfMonthPositions(days, count: 10) {
                return positions.map(Double.init)
            }
        }
        return ChartAxisTicks.evenlySpaced(Array(keys.indices), count: bars ? 12 : 8).map(Double.init)
    }

    var body: some View {
        let index = keyIndex
        let domain = yDomain
        let placement = legendPlacement
        VStack(alignment: .leading, spacing: 8) {
            if placement == .top { ChartLegendRow(items: legendItems) }
            Chart {
                ForEach(barRects) { bar in
                    RectangleMark(
                        xStart: .value(title, bar.x0), xEnd: .value(title, bar.x1),
                        yStart: .value(bar.label, bar.y0), yEnd: .value(bar.label, bar.y1)
                    )
                    .foregroundStyle(by: .value(title, bar.label))
                    .cornerRadius(3)
                }
                ForEach(plot.drawn) { line in
                    ForEach(line.points) { point in
                        // Bars are drawn above as BarRects.
                        if !(bars && !line.dashed), let x = index[point.key].map(Double.init) {
                            if drawsArea(line) && stacksAreas {
                                AreaMark(
                                    x: .value(title, x), y: .value(line.label, coordinate(point.value)),
                                    stacking: .standard
                                )
                                .foregroundStyle(by: .value(title, line.label))
                                .opacity(ChartFill.stackedOpacity)
                                .interpolationMethod(.monotone)
                            } else {
                                if drawsArea(line) {
                                    AreaMark(
                                        x: .value(title, x), yStart: .value(line.label, domain.lowerBound),
                                        yEnd: .value(line.label, coordinate(point.value)),
                                        series: .value(title, line.id)
                                    )
                                    .foregroundStyle(areaStyle(line))
                                    .interpolationMethod(.monotone)
                                    .accessibilityHidden(true)
                                }
                                LineMark(
                                    x: .value(title, x), y: .value(line.label, coordinate(point.value)),
                                    series: .value(title, line.id)
                                )
                                .foregroundStyle(by: .value(title, line.label))
                                .lineStyle(
                                    StrokeStyle(
                                        lineWidth: line.id == "actual" ? 2.5 : (drawsArea(line) ? 2 : 1.5),
                                        dash: line.dashed ? [5, 4] : []))
                                .interpolationMethod(.monotone)
                            }
                        }
                    }
                }
                if zeroLine {
                    RuleMark(y: .value(title, 0.0))
                        .foregroundStyle(theme.secondaryLabel)
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                        .accessibilityHidden(true)
                }
                if let selection, let x = index[selection] {
                    RuleMark(x: .value(title, Double(x))).foregroundStyle(
                        theme.secondaryLabel.opacity(0.5))
                }
                if let rangeStart, let selection, let a = index[rangeStart], let b = index[selection] {
                    RectangleMark(
                        xStart: .value(title, Double(min(a, b))),
                        xEnd: .value(title, Double(max(a, b)))
                    )
                    .foregroundStyle(theme.primary.opacity(0.08))
                }
            }
            .chartForegroundStyleScale(
                domain: series.map(\.label), range: series.indices.map { seriesColor(at: $0) }
            )
            .chartLegend(.hidden)
            .chartXScale(domain: xDomain)
            .chartXAxis {
                if !sparkline {
                    AxisMarks(values: xTickPositions) { value in
                        AxisTick()
                        AxisValueLabel {
                            if let position = value.as(Double.self), let key = keyAt(position) {
                                Text(tickLabel(key)).font(ChartTickText.font).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                    }
                }
            }
            .visionChartYAxis(domain: domain, hidden: sparkline, label: yLabel)
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let location):
                                // Scrolling re-reports a parked pointer every frame: write on change only.
                                let hovered = key(at: location.x, proxy: proxy, geometry: geometry)
                                if selection != hovered { selection = hovered }
                            case .ended: if rangeStart == nil, selection != nil { selection = nil }
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
            if placement == .bottomLeading { ChartLegendRow(items: legendItems) }
            if placement == .bottomCenter { ChartLegendRow(items: legendItems, centered: true) }
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
                    theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                )
                .accessibilityElement(children: .combine)
            }
        }
    }

    /// The key under an x position of the quantitative axis.
    private func keyAt(_ position: Double) -> String? {
        let rounded = Int(position.rounded())
        return keys.indices.contains(rounded) ? keys[rounded] : nil
    }

    /// An x-axis tick: `formatTick` when the caller has its own, otherwise the web's month tick
    /// ("Nov 24"), the app-format month ("05/2026") or the day number.
    private func tickLabel(_ key: String) -> String {
        if let formatTick { return formatTick(key) }
        let parts = key.split(separator: "-").compactMap { Int($0) }
        switch xLabels {
        case .dayOfMonth:
            if parts.count == 3 { return String(parts[2]) }
        case .dayMonth:
            if parts.count == 3,
                let date = Calendar.current.date(
                    from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
            {
                let formatter = FormatterCache.shared("insight.dayTick|\(locale.identifier)") {
                    () -> DateFormatter in
                    let made = DateFormatter()
                    made.locale = locale
                    made.dateFormat = "d MMM"
                    return made
                }
                return formatter.string(from: date)
            }
        case .appMonthYear:
            if parts.count >= 2 {
                return VisionFormat.monthYear(year: parts[0], month: parts[1], format: settings.dateFormat)
            }
        case .shortMonth:
            if parts.count >= 2,
                let date = Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: 1))
            {
                // Built once per locale: axis ticks format on every layout pass.
                let formatter = FormatterCache.shared("insight.tick|\(locale.identifier)") {
                    () -> DateFormatter in
                    let made = DateFormatter()
                    made.locale = locale
                    made.dateFormat = "MMM yy"
                    return made
                }
                return formatter.string(from: date)
            }
        }
        return periodLabel(key)
    }

    /// A value-axis tick: `formatAxisCompact` or the full currency format.
    private func yLabel(_ number: Double) -> String {
        switch yAxis {
        case .compact:
            return VisionFormat.currencyAxisCompact(
                Decimal(number), code: currency, locale: settings.numberFormat.locale)
        case .full:
            return VisionFormat.currency(
                Decimal(number), code: currency, locale: settings.numberFormat.locale,
                fractionDigits: settings.showDecimalPlaces)
        }
    }

    private func periodLabel(_ key: String) -> String {
        if let formatPeriod { return formatPeriod(key) }
        let parts = key.split(separator: "-")
        if parts.count == 3 { return VisionFormat.appDate(key, format: settings.dateFormat) }
        guard parts.count == 2, let year = Int(parts[0]), let month = Int(parts[1]),
            let date = Calendar.current.date(from: DateComponents(year: year, month: month, day: 1))
        else { return key }
        // Built once per locale: axis ticks format on every layout pass.
        let formatter = FormatterCache.shared("insight.period|\(locale.identifier)") {
            () -> DateFormatter in
            let made = DateFormatter()
            made.locale = locale
            made.dateFormat = "MMM yyyy"
            return made
        }
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
        // `NetTrendChart` draws its single series in `--primary` (green), never gain/loss.
        if id == "net" { return theme.primary }
        let methods = [
            "simple_avg": 0, "weighted_avg": 1, "ewma": 2, "holt_winters": 3,
            "prophet_lite": 4, "monte_carlo_parametric": 5, "monte_carlo_block_bootstrap": 6, "ensemble_imse": 7,
        ]
        return colors[(methods[id] ?? index) % colors.count]
    }
    private func key(at x: CGFloat, proxy: ChartProxy, geometry: GeometryProxy) -> String? {
        guard let plot = proxy.plotFrame else { return nil }
        let frame = geometry[plot]
        guard let position = proxy.value(atX: min(max(0, x - frame.minX), frame.width), as: Double.self) else {
            return nil
        }
        let keys = self.keys
        guard !keys.isEmpty else { return nil }
        return keys[min(max(Int(position.rounded()), 0), keys.count - 1)]
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

    /// A category's colour follows its root name (`getCategoryChartColor`), never its rank.
    private func sliceColor(_ slice: HomeCategorySlice) -> Color {
        let root =
            slice.name.split(separator: ":").first.map(String.init)?.trimmingCharacters(in: .whitespaces)
            .uppercased() ?? ""
        var hash: Int32 = 0
        for scalar in root.utf16 { hash = hash &* 31 &+ Int32(scalar) }
        return theme.chartColors[Int(abs(Int64(hash)) % 8)]
    }

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
                .chartForegroundStyleScale(domain: slices.map(\.name), range: slices.map(sliceColor))
                .chartLegend(.hidden)
                .chartBackground { _ in
                    // The hollow stays empty until a slice is hovered, as the web `DonutChart` does.
                    if let selected {
                        VStack(spacing: 4) {
                            Text(selected.name).font(.caption).multilineTextAlignment(.center)
                            Text(String(selected.count)).font(.title2.monospacedDigit())
                        }.frame(maxWidth: 120)
                    }
                }
                .frame(height: 232)
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Rectangle().fill(.clear).contentShape(Rectangle())
                            .onContinuousHover { phase in
                                switch phase {
                                case .active(let location):
                                    // Scrolling re-reports a parked pointer every frame: write on change only.
                                    let hovered = slice(at: location, proxy: proxy, geometry: geometry)?.id
                                    if selectedId != hovered { selectedId = hovered }
                                case .ended: if selectedId != nil { selectedId = nil }
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
                // Each slice stays reachable without a pointer as an accessibility action, as the
                // web chart's keyboard-focusable sectors are; no visible link row (the web has none).
                .accessibilityElement(children: .contain)
                .accessibilityActions {
                    ForEach(slices) { slice in
                        Button(slice.name) { navigate(slice.route.string) }
                    }
                }
                ChartLegendRow(
                    items: slices.map { ChartLegendItem(id: $0.id, label: $0.name, color: sliceColor($0)) },
                    centered: true)
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

/// A `Toggle(.button)` drawn as the web's pressed-state button: `variant="outline"` while off and
/// `variant="secondary"` while on, at `size="sm"`. It reads to VoiceOver as a toggle, with the
/// selected trait carrying the on state.
struct InsightToggleButton<Label: View>: View {
    @Binding var isOn: Bool
    var size: VisionButtonSize = .sm
    @ViewBuilder var label: () -> Label

    private var traits: AccessibilityTraits { isOn ? [.isToggle, .isSelected] : [.isToggle] }

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            label()
        }
        .buttonStyle(.vision(isOn ? .secondary : .outline, size: size))
        .accessibilityAddTraits(traits)
    }
}

extension InsightToggleButton where Label == Text {
    init(_ title: String, isOn: Binding<Bool>, size: VisionButtonSize = .sm) {
        self.init(isOn: isOn, size: size) { Text(title) }
    }
}
