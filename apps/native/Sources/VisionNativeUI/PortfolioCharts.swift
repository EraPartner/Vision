import Charts
import SwiftUI
import VisionNativeCore

/// Plot coordinates alone use Double. Selection, endpoint comparisons and every
/// readout retain the Decimal figures delivered by the portfolio service.
struct PortfolioSeriesChart: View {
    let series: [InsightChartSeries]
    let title: String
    let currency: CurrencyCode
    let shell: NativeShellModel
    var percent = false
    var area = false
    var height: CGFloat = 280
    /// The web's `xTickPattern`: day ticks ("d MMM") for 1M/3M/6M, month ticks ("MMM yy") otherwise.
    var dayTicks = false
    var colors: [String: Color] = [:]
    /// The chart's main line (`primary`): it leads the range-compare readout and tints its band.
    var primary: String?
    @State private var selected: String?
    /// Range compare (`scrubbable`): drag, or click, move, click.
    @State private var scrub = ChartScrub()
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    /// The sorted keys and their positions, the thinned lines and the value coordinates,
    /// rebuilt only when the series change.
    @State private var plotCache = ChartSeriesPlotCache()
    /// The accessibility strings of each drawn point, formatted once per series and context.
    @State private var markLabels = ChartMarkLabelCache()
    /// Date strings shared by the lines' marks, formatted once per context.
    @State private var labelMemo = ChartLabelMemo()
    private var keys: [String] { plotCache.plot(for: series).layout.keys }

    var body: some View {
        let plot = plotCache.plot(for: series)
        let keys = plot.layout.keys
        // Each key's position: the x axis is quantitative over these indices, so it draws only
        // the requested ticks. A String-keyed (categorical) axis drew a grid line and a label
        // for every day of a long series.
        let index = plot.layout.index
        // The web AreaChart's fitted domain: the data range plus an 8 % margin, niced, not
        // zero-based, so a slowly growing portfolio fills the plot instead of a flat line at
        // the top. It spans the full series, not only the drawn points.
        let domain = ChartAxisTicks.fittedDomain(plot.values)
        let context = labelContext
        VStack(alignment: .leading, spacing: 10) {
            Chart {
                ForEach(plot.drawn) { line in
                    let color = lineColor(line)
                    let marks = markLabels.marks(for: line, context: context) { point in
                        ChartMarkLabelCache.Mark(
                            label: line.label + ". " + pointDate(point.key), value: format(point.value))
                    }
                    ForEach(line.points.indices, id: \.self) { position in
                        let point = line.points[position]
                        if area && !line.dashed, let x = index[point.key] {
                            AreaMark(
                                x: .value(title, x), yStart: .value(line.label, domain.lowerBound),
                                yEnd: .value(line.label, coordinate(point.value)),
                                series: .value(title, line.id)
                            )
                            .foregroundStyle(ChartFill.areaGradient(color))
                            .interpolationMethod(.monotone)
                            .accessibilityHidden(true)
                        }
                        if let x = index[point.key] {
                            LineMark(
                                x: .value(title, x), y: .value(line.label, coordinate(point.value)),
                                series: .value(title, line.id)
                            )
                            .foregroundStyle(color)
                            .lineStyle(
                                StrokeStyle(
                                    lineWidth: line.dashed ? 1.5 : 2.5, lineCap: .round, lineJoin: .round,
                                    dash: line.dashed ? [4, 4] : [])
                            )
                            .interpolationMethod(.monotone)
                            .accessibilityLabel(marks[position].label)
                            .accessibilityValue(marks[position].value)
                        }
                    }
                }
                if scrub.range == nil, let selected, let x = index[selected] {
                    RuleMark(x: .value(title, x)).foregroundStyle(theme.secondaryLabel.opacity(0.5))
                }
            }
            .chartXScale(domain: 0...max(keys.count - 1, 1))
            .chartLegend(.hidden)
            .chartXAxis {
                AxisMarks(values: ChartAxisTicks.evenlySpaced(Array(keys.indices), count: 7)) { value in
                    AxisValueLabel {
                        if let position = value.as(Int.self), keys.indices.contains(position) {
                            Text(dateLabel(keys[position], pattern: dayTicks ? "d MMM" : "MMM yy"))
                                .font(ChartTickText.font).foregroundStyle(theme.secondaryLabel)
                        }
                    }
                }
            }
            .visionChartYAxis(domain: domain) { format(Decimal($0), axis: true) }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    let series = plot.scrubSeries(primary: primary)
                    ChartRangeCompareLayer(
                        scrub: $scrub, plot: proxy.plotFrame.map { geometry[$0] } ?? .zero,
                        view: ChartScrubView(scrub, count: keys.count, series: series),
                        indexAt: { position(at: $0, proxy: proxy) },
                        xOf: { proxy.position(forX: Double($0)) },
                        yOf: { _, value in proxy.position(forY: value) },
                        colorOf: { key in series.firstIndex { $0.key == key }.map { lineColor(self.series[$0]) } ?? theme.primary },
                        titleOf: { keys.indices.contains($0) ? dateLabel(keys[$0]) : "" },
                        deltaOf: { row in
                            ChartScrubDelta.text(
                                start: row.start, end: row.end, formatValue: { format(Decimal($0)) },
                                formatPercent: percent ? nil : { scrubPercent($0) })
                        },
                        onHover: { hovered in
                            let key = hovered.flatMap { keys.indices.contains($0) ? keys[$0] : nil }
                            if selected != key { selected = key }
                        },
                        onPress: { focused = true })
                }
            }
            .frame(height: height).focusable().focused($focused).focusEffectDisabled()
            .accessibilityLabel(title)
            // Every portfolio chart is a web `AreaChart`, lines-only ones included.
            .accessibilityValue(
                ChartAccessibility.series(
                    shell.strings, kind: .area, categoryCount: keys.count, seriesLabels: series.map(\.label)))
            .onKeyPress(phases: .down, action: moveSelection)
            .onChange(of: plot.scrubTimeline, initial: true) { _, timeline in scrub.sync(timeline: timeline) }
            .onChange(of: series) { _, _ in selected = nil }
            .onChange(of: focused) { _, focused in
                if !focused {
                    selected = nil
                    scrub.clear()
                }
            }
            ChartLegendRow(
                items: series.enumerated().map { index, line in
                    ChartLegendItem(
                        id: line.id, label: line.label,
                        color: colors[line.id] ?? Color(token: palette[index % palette.count]), dashed: line.dashed)
                })
            if scrub.range == nil, let selected, keys.contains(selected) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(dateLabel(selected)).font(.caption.weight(.medium))
                    ForEach(series) { line in
                        if let value = line.points.first(where: { $0.key == selected })?.value {
                            HStack {
                                Text(line.label).foregroundStyle(theme.secondaryLabel)
                                Spacer()
                                Text(format(value)).monospacedDigit()
                            }.font(.caption)
                        }
                    }
                }.padding(10)
                    .background(
                        theme.foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                    )
                    .accessibilityElement(children: .combine)
            }
        }
    }
    /// What the date and value strings of a point depend on besides the point.
    private var labelContext: String {
        let locale = shell.settings.numberFormat.locale.identifier
        let language = shell.strings.language.rawValue
        return "\(language)|\(locale)|\(currency.rawValue)|\(percent)|\(shell.settings.showDecimalPlaces)"
    }
    private func pointDate(_ key: String) -> String {
        labelMemo.label(key, context: labelContext) { dateLabel(key) }
    }
    private func lineColor(_ line: InsightChartSeries) -> Color {
        let position = series.firstIndex { $0.id == line.id } ?? 0
        return colors[line.id] ?? Color(token: palette[position % palette.count])
    }
    private var palette: [HSLColor] {
        [
            theme.palette.chart1, theme.palette.chart2, theme.palette.chart3,
            theme.palette.chart4, theme.palette.chart5, theme.palette.chart6, theme.palette.chart7,
            theme.palette.chart8,
        ]
    }
    private func coordinate(_ value: Decimal) -> Double { NSDecimalNumber(decimal: value).doubleValue }
    private func format(_ value: Decimal, axis: Bool = false, signed: Bool = false) -> String {
        if percent {
            return (signed && value > 0 ? "+" : "")
                + VisionFormat.percent(
                    value,
                    digits: axis ? 0 : 2, locale: shell.settings.numberFormat.locale)
        }
        return VisionFormat.currency(
            value, code: currency, locale: shell.settings.numberFormat.locale,
            fractionDigits: axis ? 0 : shell.settings.showDecimalPlaces, signed: signed)
    }
    /// `formatDate(parseISO(day), pattern, appLanguageToLocale(language))`: month names follow the
    /// app language, never the system or number-format locale. The default is the web's
    /// `CHART_DATE_PATTERNS.detail`.
    private func dateLabel(_ key: String, pattern: String = "d MMM yyyy") -> String {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        guard parts.count >= 2,
            let date = calendar.date(
                from: DateComponents(
                    year: parts[0], month: parts[1], day: parts.count > 2 ? parts[2] : 1))
        else { return key }
        let locale = LanguageLocale.locale(shell.strings.language)
        let formatter = FormatterCache.shared("portfolio.chart|\(locale.identifier)|\(pattern)") {
            () -> DateFormatter in
            let made = DateFormatter()
            made.locale = locale
            made.calendar = Calendar(identifier: .gregorian)
            made.dateFormat = pattern
            return made
        }
        return formatter.string(from: date)
    }
    /// The nearest key position to a plot x.
    private func position(at x: CGFloat, proxy: ChartProxy) -> Int? {
        let keys = self.keys
        guard !keys.isEmpty, let position = proxy.value(atX: x, as: Double.self) else { return nil }
        return min(max(Int(position.rounded()), 0), keys.count - 1)
    }
    private func scrubPercent(_ value: Double) -> String {
        VisionFormat.percent(Decimal(value), digits: 1, locale: shell.settings.numberFormat.locale)
    }
    /// The shared chart key map: ←/→, Home/End, Shift+←/→ range compare, Escape.
    private func moveSelection(_ press: KeyPress) -> KeyPress.Result {
        let keys = self.keys
        if press.key == .escape {
            guard selected != nil || scrub.scrubbing else { return .ignored }
            selected = nil
            scrub.clear()
            return .handled
        }
        guard let chartKey = press.chartKey,
            let next = scrub.key(
                chartKey, shift: press.modifiers.contains(.shift), index: selected.flatMap(keys.firstIndex),
                count: keys.count)
        else { return .ignored }
        selected = keys[next]
        return .handled
    }
}

struct PortfolioCard<Content: View, Accessory: View>: View {
    let title: String
    var description: String? = nil
    /// `CardTitle` default (type-title-2) rather than `variant="sm"` (type-title-3).
    var large = false
    /// The trailing header control (the web `CardHeader` row's right side).
    @ViewBuilder var accessory: () -> Accessory
    @ViewBuilder var content: () -> Content
    @Environment(\.visionTheme) private var theme

    init(
        title: String, description: String? = nil, large: Bool = false,
        @ViewBuilder accessory: @escaping () -> Accessory, @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.description = description
        self.large = large
        self.accessory = accessory
        self.content = content
    }

    var body: some View {
        AdminCard(padding: 24) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(large ? .visionCardTitle : Font.visionTitle3)
                            .accessibilityAddTraits(.isHeader)
                        if let description { Text(description).foregroundStyle(theme.secondaryLabel) }
                    }
                    Spacer(minLength: 0)
                    accessory()
                }
                content()
            }
        }
    }
}

extension PortfolioCard where Accessory == EmptyView {
    init(
        title: String, description: String? = nil, large: Bool = false, @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(title: title, description: description, large: large, accessory: { EmptyView() }, content: content)
    }
}

struct PortfolioInlineDisclosure: View {
    let label: String
    let explanation: String
    @State private var open = false
    var body: some View {
        Button(label) { open = true }.buttonStyle(.plain).visionTooltip(explanation)
            .accessibilityLabel(label == "ⓘ" ? explanation : label + ". " + explanation)
            .popover(isPresented: $open) { Text(explanation).padding(16).frame(maxWidth: 320) }
    }
}

enum PortfolioChartTicks {
    /// The web `xTickPattern`: day ticks for 1M, 3M and 6M, month ticks for longer periods.
    static func usesDayTicks(_ period: PortfolioPeriod) -> Bool {
        switch period {
        case .oneMonth, .threeMonths, .sixMonths: return true
        case .oneYear, .threeYears, .all: return false
        }
    }
}
