import Charts
import SwiftUI
import VisionNativeCore

/// Percentile bands and invested capital are authoritative server amounts.
/// Double is used only for the chart coordinates and date hit testing.
struct ResearchForecastChart: View {
    let points: [ResearchForecastPoint]
    let currency: CurrencyCode
    let shell: NativeShellModel
    let isLoading: Bool
    @State private var selected: Int?
    /// Range compare (`scrubbable`), led by the median.
    @State private var scrub = ChartScrub()
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme
    init(points: [ResearchForecastPoint], currency: CurrencyCode, shell: NativeShellModel, isLoading: Bool) {
        self.points = points
        self.currency = currency
        self.shell = shell
        self.isLoading = isLoading
    }
    private struct Series: Identifiable {
        let id: String
        let value: KeyPath<ResearchForecastPoint, Decimal>
        let color: Color
        let width: CGFloat
        var dashed = false
    }
    private var series: [Series] {
        [
            .init(id: "p90", value: \.p90, color: Color(token: theme.palette.accent), width: 1, dashed: true),
            .init(id: "p75", value: \.p75, color: Color(token: theme.palette.accent), width: 1),
            .init(id: "p50", value: \.p50, color: theme.primary, width: 2.5),
            .init(id: "p25", value: \.p25, color: theme.destructive, width: 1),
            .init(id: "p10", value: \.p10, color: theme.destructive, width: 1, dashed: true),
            .init(id: "netInvested", value: \.netInvested, color: theme.secondaryLabel, width: 1.5, dashed: true),
        ]
    }
    /// The web LineChart's value domain: the data range plus 8 %, niced, never zero-based, so the
    /// fan of percentiles fills the plot.
    private var yDomain: ClosedRange<Double> {
        ChartAxisTicks.fittedDomain(
            series.flatMap { line in points.map { coordinate($0[keyPath: line.value]) } })
    }

    /// Month step of the x-axis ticks: the smallest of 1, 3, 6, 12, 24 or 60 months that keeps
    /// the span to eight ticks or fewer (a four-year fan is labelled every half year).
    private var tickMonths: Int {
        guard let first = points.first.flatMap({ date($0.date) }), let last = points.last.flatMap({ date($0.date) })
        else { return 6 }
        let span = Calendar.current.dateComponents([.month], from: first, to: last).month ?? 0
        return [1, 3, 6, 12, 24, 60].first { span / $0 <= 8 } ?? 60
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ChartLegendRow(
                items: series.map {
                    ChartLegendItem(id: $0.id, label: label($0), color: $0.color, dashed: $0.dashed)
                })
            Text(shell.strings.t("research.forecast.intervalHint")).font(.caption).foregroundStyle(theme.secondaryLabel)
            if isLoading {
                RoundedRectangle(cornerRadius: DesignTokens.Radius.control).fill(theme.muted).frame(height: 360)
                    .accessibilityLabel(shell.strings.t("common.loading"))
            } else if points.isEmpty {
                VisionEmptyState(
                    symbol: "chart.line.uptrend.xyaxis", title: shell.strings.t("research.forecast.noData")
                ) {}
                .frame(height: 360)
            } else {
                Chart {
                    ForEach(series) { line in
                        ForEach(points, id: \.monthIndex) { point in
                            if let date = date(point.date) {
                                LineMark(
                                    x: .value("date", date),
                                    y: .value(label(line), coordinate(point[keyPath: line.value])),
                                    series: .value("series", line.id)
                                )
                                .foregroundStyle(line.color)
                                .interpolationMethod(.monotone)
                                .lineStyle(StrokeStyle(lineWidth: line.width, dash: line.dashed ? [5, 4] : []))
                                .accessibilityLabel(fullDate(point.date) + ", " + label(line))
                                .accessibilityValue(money(point[keyPath: line.value]))
                            }
                        }
                    }
                    if scrub.range == nil, let index = selected, points.indices.contains(index),
                        let date = date(points[index].date)
                    {
                        RuleMark(x: .value("date", date)).foregroundStyle(theme.secondaryLabel.opacity(0.5))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3])).accessibilityHidden(true)
                        // The web LineChart's active dots: a ring in each line's colour at the hovered month.
                        ForEach(series) { line in
                            PointMark(
                                x: .value("date", date), y: .value(label(line), coordinate(points[index][keyPath: line.value])))
                            .symbol {
                                Circle().strokeBorder(line.color, lineWidth: 2)
                                    .background(Circle().fill(theme.background))
                                    .frame(width: 9, height: 9)
                            }
                            .accessibilityHidden(true)
                        }
                    }
                }
                .chartLegend(.hidden)
                .chartXAxis {
                    AxisMarks(values: .stride(by: .month, count: tickMonths)) { value in
                        AxisTick()
                        if let date = value.as(Date.self) {
                            AxisValueLabel {
                                Text(
                                    date.formatted(
                                        Date.FormatStyle(locale: LanguageLocale.locale(shell.strings.language))
                                            .month(.abbreviated).year())
                                )
                                .font(ChartTickText.font).foregroundStyle(theme.secondaryLabel)
                            }
                        }
                    }
                }
                .visionChartYAxis(domain: yDomain) { money(Decimal($0)) }
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        let lines = series
                        ChartRangeCompareLayer(
                            scrub: $scrub, plot: proxy.plotFrame.map { geometry[$0] } ?? .zero,
                            view: ChartScrubView(scrub, count: points.count, series: scrubSeries),
                            indexAt: { x in proxy.value(atX: x, as: Date.self).flatMap(nearest) },
                            xOf: { index in
                                points.indices.contains(index) ? date(points[index].date).flatMap { proxy.position(forX: $0) } : nil
                            },
                            yOf: { _, value in proxy.position(forY: value) },
                            colorOf: { key in lines.first { $0.id == key }?.color ?? theme.primary },
                            titleOf: { points.indices.contains($0) ? fullDate(points[$0].date) : "" },
                            deltaOf: { row in
                                ChartScrubDelta.text(
                                    start: row.start, end: row.end, formatValue: { money(Decimal($0)) },
                                    formatPercent: {
                                        VisionFormat.percent(
                                            Decimal($0), digits: 1, locale: shell.settings.numberFormat.locale)
                                    })
                            },
                            onHover: { index in
                                if index == nil, focused { return }
                                if selected != index { selected = index }
                            },
                            onPress: { focused = true })
                        // `ChartTooltip`: the hovered month's percentiles and capital in, floating
                        // above the median, so the layout below the chart never moves.
                        if scrub.range == nil, let index = selected, points.indices.contains(index),
                            let day = date(points[index].date),
                            let frame = proxy.plotFrame.map({ geometry[$0] }),
                            let x = proxy.position(forX: day),
                            let y = proxy.position(forY: coordinate(points[index].p90))
                        {
                            ChartHoverTooltip(
                                title: fullDate(points[index].date),
                                items: lines.map { line in
                                    ChartTooltipItem(
                                        id: line.id, label: label(line), value: money(points[index][keyPath: line.value]),
                                        color: line.color)
                                },
                                anchor: CGPoint(x: frame.minX + x, y: frame.minY + y), bounds: geometry.size)
                        }
                    }
                }
                .frame(height: 360).focusable().focused($focused)
                .onKeyPress(phases: .down) { press in
                    ChartKeyboard.handle(press, scrub: &scrub, selected: &selected, count: points.count)
                }
                .onChange(of: focused) { _, focused in if !focused { scrub.clear() } }
                .accessibilityLabel(shell.strings.t("research.forecast.chartTitle"))
                .chartAccessibilitySummary { strings in
                    ChartAccessibility.series(
                        strings, kind: .line, categoryCount: points.count, seriesLabels: series.map(label))
                }
            }
        }
        .onChange(of: points) { _, _ in selected = nil }
        .onChange(of: scrubTimeline, initial: true) { _, timeline in scrub.sync(timeline: timeline) }
    }
    private func label(_ line: Series) -> String { shell.strings.t("research.forecast." + line.id) }
    private func coordinate(_ value: Decimal) -> Double { NSDecimalNumber(decimal: value).doubleValue }
    private func money(_ value: Decimal) -> String {
        ResearchForecastDisplay.money(value, currency: currency, shell: shell)
    }
    private func date(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
    private func fullDate(_ day: String) -> String { VisionFormat.appDate(day, format: shell.settings.dateFormat) }
    /// The point nearest a date.
    private func nearest(_ hovered: Date) -> Int? {
        points.indices.min {
            abs((date(points[$0].date) ?? .distantPast).timeIntervalSince(hovered))
                < abs((date(points[$1].date) ?? .distantPast).timeIntervalSince(hovered))
        }
    }
    /// Every line as a range-compare series; the median leads.
    private var scrubSeries: [ChartScrubSeries] {
        series.map { line in
            let values = points.map { coordinate($0[keyPath: line.value]) }
            return ChartScrubSeries(key: line.id, label: label(line), primary: line.id == "p50") { index in
                values.indices.contains(index) ? values[index] : nil
            }
        }
    }
    private var scrubTimeline: String {
        "\(points.count):\(points.first?.date ?? ""):\(points.last?.date ?? "")"
    }
}
