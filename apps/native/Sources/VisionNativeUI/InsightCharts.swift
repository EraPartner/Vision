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
    /// `scrubbable`: range compare (drag, or click, move, click), on the charts the web makes
    /// scrubbable.
    var rangeComparison = false
    var height: CGFloat = 240
    var customColors: [String: Color] = [:]
    var areaSeries: Set<String>? = nil
    /// The chart's main line (`primary`): it leads the range-compare readout and tints its band.
    var primary: String? = nil
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
    /// The highlighted point, and while a range is compared its moving end.
    @Binding var selection: String?
    /// The compared range's anchor, mirrored from `scrub` for print reports.
    @Binding var rangeStart: String?
    @State private var scrub = ChartScrub()
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
    private func yDomain(rects: [BarRect], stacks: Bool) -> ClosedRange<Double> {
        if sparkline {
            let values = series.flatMap { $0.points.map { coordinate($0.value) } }
            let low = values.min() ?? 0
            let high = values.max() ?? 1
            let pad = high != low ? (high - low) * 0.1 : 1
            return (low - pad)...(high + pad)
        }
        if !rects.isEmpty {
            let overlays = series.filter(\.dashed).flatMap { $0.points.map { coordinate($0.value) } }
            return ChartAxisTicks.zeroBasedDomain(rects.flatMap { [$0.y0, $0.y1] } + overlays)
        }
        if stacks {
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
        // Once per pass: each of these scans every point, and the marks below ask per point.
        let rects = barRects
        let stacks = stacksAreas
        let domain = yDomain(rects: rects, stacks: stacks)
        let placement = legendPlacement
        VStack(alignment: .leading, spacing: 8) {
            if placement == .top { ChartLegendRow(items: legendItems) }
            Chart {
                ForEach(rects) { bar in
                    RectangleMark(
                        xStart: .value(title, bar.x0), xEnd: .value(title, bar.x1),
                        yStart: .value(bar.label, bar.y0), yEnd: .value(bar.label, bar.y1)
                    )
                    .foregroundStyle(by: .value(title, bar.label))
                    .cornerRadius(3)
                }
                ForEach(plot.drawn) { line in
                    // Per line, not per point: the fill gradient and the line style are the same
                    // for every point of a line.
                    let area = drawsArea(line)
                    let fill = area && !stacks ? areaStyle(line) : AnyShapeStyle(Color.clear)
                    let strokeWidth: CGFloat = line.id == "actual" ? 2.5 : (area ? 2 : 1.5)
                    let stroke = StrokeStyle(lineWidth: strokeWidth, dash: line.dashed ? [5, 4] : [])
                    ForEach(line.points) { point in
                        // Bars are drawn above as BarRects.
                        if !(bars && !line.dashed), let x = index[point.key].map(Double.init) {
                            if area && stacks {
                                AreaMark(
                                    x: .value(title, x), y: .value(line.label, coordinate(point.value)),
                                    stacking: .standard
                                )
                                .foregroundStyle(by: .value(title, line.label))
                                .opacity(ChartFill.stackedOpacity)
                                .interpolationMethod(.monotone)
                            } else {
                                if area {
                                    AreaMark(
                                        x: .value(title, x), yStart: .value(line.label, domain.lowerBound),
                                        yEnd: .value(line.label, coordinate(point.value)),
                                        series: .value(title, line.id)
                                    )
                                    .foregroundStyle(fill)
                                    .interpolationMethod(.monotone)
                                    .accessibilityHidden(true)
                                }
                                LineMark(
                                    x: .value(title, x), y: .value(line.label, coordinate(point.value)),
                                    series: .value(title, line.id)
                                )
                                .foregroundStyle(by: .value(title, line.label))
                                .lineStyle(stroke)
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
                if scrub.range == nil, let selection, let x = index[selection] {
                    RuleMark(x: .value(title, Double(x))).foregroundStyle(
                        theme.secondaryLabel.opacity(0.5))
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
                    let scrubSeries = plot.scrubSeries(primary: primary)
                    ChartRangeCompareLayer(
                        scrub: $scrub, plot: proxy.plotFrame.map { geometry[$0] } ?? .zero,
                        view: rangeComparison ? ChartScrubView(scrub, count: keys.count, series: scrubSeries) : nil,
                        indexAt: { x in
                            let keys = self.keys
                            guard !keys.isEmpty, let position = proxy.value(atX: x, as: Double.self) else { return nil }
                            return min(max(Int(position.rounded()), 0), keys.count - 1)
                        },
                        xOf: { proxy.position(forX: Double($0)) },
                        yOf: { _, value in proxy.position(forY: value) },
                        colorOf: { key in series.firstIndex { $0.id == key }.map(seriesColor(at:)) ?? theme.primary },
                        titleOf: { keys.indices.contains($0) ? periodLabel(keys[$0]) : "" },
                        deltaOf: { row in
                            ChartScrubDelta.text(
                                start: row.start, end: row.end,
                                formatValue: { MoneyText.text(Decimal($0), currency: currency, settings: settings) },
                                formatPercent: {
                                    VisionFormat.percent(Decimal($0), digits: 1, locale: settings.numberFormat.locale)
                                })
                        },
                        onHover: { position in
                            // A compared range keeps its end; the hover readout waits for it to clear.
                            guard scrub.range == nil else { return }
                            let hovered = position.flatMap { keys.indices.contains($0) ? keys[$0] : nil }
                            if position == nil, scrub.scrubbing { return }
                            if selection != hovered { selection = hovered }
                        },
                        onPress: { focused = true },
                        scrubbable: rangeComparison)
                }
            }
            .frame(height: height)
            .focusable().focused($focused).focusEffectDisabled()
            .onKeyPress(phases: .down, action: handleKey)
            .onChange(of: focused) { _, value in
                if !value {
                    selection = nil
                    scrub.clear()
                }
            }
            .onChange(of: plot.scrubTimeline, initial: true) { _, timeline in scrub.sync(timeline: timeline) }
            .onChange(of: scrub) { _, scrub in mirror(scrub) }
            .onChange(of: rangeStart) { _, start in
                // The owner dropped the range (a new period or filter).
                if start == nil, scrub.range != nil { scrub.clear() }
            }
            .accessibilityLabel(title)
            if placement == .bottomLeading { ChartLegendRow(items: legendItems) }
            if placement == .bottomCenter { ChartLegendRow(items: legendItems, centered: true) }
            if scrub.range == nil, let selection {
                VStack(alignment: .leading, spacing: 3) {
                    Text(periodLabel(selection)).font(.caption.weight(.medium))
                    ForEach(series) { line in
                        if let value = line.points.first(where: { $0.key == selection })?.value {
                            HStack {
                                Text(line.label).foregroundStyle(theme.secondaryLabel)
                                Spacer()
                                MoneyText(
                                    amount: value, currency: currency, settings: settings, signed: false,
                                    colored: false)
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
    private static let methodColorIndex: [String: Int] = [
        "simple_avg": 0, "weighted_avg": 1, "ewma": 2, "holt_winters": 3,
        "prophet_lite": 4, "monte_carlo_parametric": 5, "monte_carlo_block_bootstrap": 6, "ensemble_imse": 7,
    ]
    private func seriesColor(at index: Int) -> Color {
        let line = series[index]
        if let color = customColors[line.id] { return color }
        let id = line.id.components(separatedBy: "__").first ?? line.id
        if id == "actual" { return theme.primary }
        if id == "income" { return theme.gain }
        if id == "spending" { return theme.loss }
        // `NetTrendChart` draws its single series in `--primary` (green), never gain/loss.
        if id == "net" { return theme.primary }
        let palette = colors
        return palette[(Self.methodColorIndex[id] ?? index) % palette.count]
    }
    /// Mirrors the compared range into the owner's bindings: the anchor as `rangeStart`, the
    /// moving end as `selection`.
    private func mirror(_ scrub: ChartScrub) {
        let keys = self.keys
        func key(_ position: Int?) -> String? { position.flatMap { keys.indices.contains($0) ? keys[$0] : nil } }
        guard scrub.range != nil else {
            if rangeStart != nil { rangeStart = nil }
            return
        }
        let anchor = key(scrub.anchor)
        let head = key(scrub.head)
        if rangeStart != anchor { rangeStart = anchor }
        if selection != head { selection = head }
    }
    private func handleKey(_ press: KeyPress) -> KeyPress.Result {
        let keys = self.keys
        if press.key == .escape {
            guard selection != nil || scrub.scrubbing else { return .ignored }
            selection = nil
            scrub.clear()
            return .handled
        }
        guard let chartKey = press.chartKey else { return .ignored }
        let shift = rangeComparison && press.modifiers.contains(.shift)
        let current = selection.flatMap(keys.firstIndex)
        guard let next = scrub.key(chartKey, shift: shift, index: current, count: keys.count) else { return .ignored }
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
